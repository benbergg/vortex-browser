import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { getSnapshotEntry } from "../src/lib/snapshot-store.js";

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

const realms: JSDOM[] = [];
afterEach(() => { for (const dom of realms.splice(0)) dom.window.close(); });

type FrameRow = { frameId: number; parentFrameId: number; url: string };

function stubChrome(opts: {
  frames: FrameRow[];
  /** frameId -> page result or null (cross-origin/failed) */
  scanResults: Record<number, any>;
  /** frameId -> iframe rect offset (for parent lookup) */
  iframeRects?: Record<number, { x: number; y: number } | null>;
}) {
  const frames = opts.frames.map((frame) => ({ ...frame, documentId: `doc-${frame.frameId}` }));
  const documents = new Map<number, JSDOM>();
  const scanFailures: Array<{ frameId: number; documentId: string; scanned: boolean; retired: boolean }> = [];
  for (const frame of frames) {
    const dom = new JSDOM("<!doctype html><body></body>", { url: frame.url, runScripts: "outside-only", pretendToBeVisual: true });
    documents.set(frame.frameId, dom);
    realms.push(dom);
    const win = dom.window as any;
    win.CSS = { escape: String };
    win.document.elementFromPoint = () => null;
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    if (opts.scanResults[frame.frameId] === null) {
      const query = win.document.querySelectorAll.bind(win.document);
      win.document.querySelectorAll = (selector: string) => {
        if (win.document.__vortexScanOwner?.scanned) {
          scanFailures.push({ ...win.document.__vortexScanOwner });
          win.document.querySelectorAll = query;
          throw new Error("controlled scan failure after claim");
        }
        return query(selector);
      };
    }
    for (const spec of opts.scanResults[frame.frameId]?.elements ?? []) {
      const [tag, ...classes] = spec._sel.split(".");
      const el = win.document.createElement(tag);
      el.className = classes.join(" ");
      el.setAttribute("role", "button");
      el.textContent = spec.name;
      win.document.body.append(el);
    }
    for (const child of frames.filter((item) => item.parentFrameId === frame.frameId)) {
      const iframe = win.document.createElement("iframe");
      iframe.src = child.url;
      const offset = opts.iframeRects?.[child.frameId] ?? { x: 0, y: 0 };
      iframe.getBoundingClientRect = () => ({ left: offset.x, top: offset.y, x: offset.x, y: offset.y, width: 400, height: 300, right: offset.x + 400, bottom: offset.y + 300 });
      win.document.body.append(iframe);
    }
  }
  const executeScript = vi.fn(async ({ target, func, args = [], files }: any) => {
    if (files || target.allFrames) return [];
    const frame = target.documentIds
      ? frames.find((item) => item.documentId === target.documentIds[0])
      : frames.find((item) => item.frameId === (target.frameIds?.[0] ?? 0));
    if (!frame) return [];
    const win = documents.get(frame.frameId)!.window as any;
    const result = win.eval(`(${String(func)})`)(...structuredClone(args));
    if (Array.isArray(result?.elements)) {
      // Preserve fixture selectors for routing assertions, not CSS path generation.
      result.elements.forEach((element: any, index: number) => { element._sel = opts.scanResults[frame.frameId].elements[index]._sel; });
    }
    return [{ frameId: frame.frameId, documentId: frame.documentId, result }];
  });

  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42 }]),
    },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue(frames),
    },
    scripting: { executeScript },
  });
  return Object.assign(executeScript, { documents, scanFailures });
}

/** 辅助：造一个最小合法的 page-side 扫描结果 */
function mkPage(elements: Array<{ selector: string; name?: string }>) {
  return {
    url: "https://a/",
    title: "T",
    viewport: { width: 1000, height: 800, scrollY: 0, scrollHeight: 800 },
    elements: elements.map((e, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: e.name ?? "",
      bbox: { x: 0, y: 0, w: 20, h: 20 },
      visible: true,
      inViewport: true,
      attrs: {},
      _sel: e.selector,
    })),
    candidateCount: elements.length,
    truncated: false,
  };
}

describe("observe multi-frame (@since 0.4.0)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("chrome", { webNavigation: {} });
    router = new ActionRouter();
    registerObserveHandlers(router);
  });

  it("default `frames: 'main'` scans only top frame and returns version 2", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a/" },
        { frameId: 65, parentFrameId: 0, url: "https://a/child" },
      ],
      scanResults: {
        0: mkPage([{ selector: "button.a" }, { selector: "button.b" }]),
        65: mkPage([{ selector: "button.iframe" }]),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    expect(resp.error).toBeUndefined();
    const r = resp.result as any;
    expect(r.version).toBe(2);
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({ frameId: 0, elementCount: 2, scanned: true });
    expect(r.elements).toHaveLength(2);
    expect(r.elements.every((e: any) => e.frameId === 0)).toBe(true);
  });

  it("`frames: 'all-same-origin'` scans both frames and assigns global indexes", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a/" },
        { frameId: 65, parentFrameId: 0, url: "https://a/child" },
      ],
      scanResults: {
        0: mkPage([{ selector: "button.top-1" }, { selector: "button.top-2" }]),
        65: mkPage([{ selector: "button.child-1" }]),
      },
      iframeRects: { 65: { x: 60, y: 0 } },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-same-origin" }, 42),
    );
    const r = resp.result as any;
    expect(r.elements).toHaveLength(3);
    expect(r.elements.map((e: any) => e.index)).toEqual([0, 1, 2]);
    expect(r.elements[0].frameId).toBe(0);
    expect(r.elements[1].frameId).toBe(0);
    expect(r.elements[2].frameId).toBe(65);
    expect(r.frames).toHaveLength(2);
    const child = r.frames.find((f: any) => f.frameId === 65);
    expect(child.offset).toEqual({ x: 60, y: 0 });
  });

  it("`frames: 'all-same-origin'` excludes cross-origin frames", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a/" },
        { frameId: 77, parentFrameId: 0, url: "https://b.other/" },
      ],
      scanResults: {
        0: mkPage([{ selector: "button.top" }]),
        77: mkPage([{ selector: "button.cross" }]),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-same-origin" }, 42),
    );
    const r = resp.result as any;
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0].frameId).toBe(0);
    expect(r.elements.every((e: any) => e.frameId === 0)).toBe(true);
  });

  it("stores per-element frameId in snapshot for resolveTarget routing", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a/" },
        { frameId: 65, parentFrameId: 0, url: "https://a/child" },
      ],
      scanResults: {
        0: mkPage([{ selector: "button.top" }]),
        65: mkPage([{ selector: "button.child" }]),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-same-origin" }, 42),
    );
    const r = resp.result as any;
    const entry = getSnapshotEntry(r.snapshotId);
    expect(entry).toBeDefined();
    // 跨 frame：entry.frameId 不设置，元素各自带 frameId
    expect(entry!.frameId).toBeUndefined();
    expect(entry!.elements[0]).toMatchObject({
      index: 0,
      selector: "button.top",
      frameId: 0,
    });
    expect(entry!.elements[1]).toMatchObject({
      index: 1,
      selector: "button.child",
      frameId: 65,
    });
  });

  it("single-frame snapshot preserves backward-compat entry.frameId hint", async () => {
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://a/" }],
      scanResults: { 0: mkPage([{ selector: "button.a" }]) },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as any;
    const entry = getSnapshotEntry(r.snapshotId);
    expect(entry!.frameId).toBe(0);
  });

  it("legacy `frameId` param scans only that frame (ignores `frames`)", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a/" },
        { frameId: 65, parentFrameId: 0, url: "https://a/child" },
      ],
      scanResults: {
        0: mkPage([{ selector: "button.top" }]),
        65: mkPage([{ selector: "button.child-only" }]),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frameId: 65, frames: "all-same-origin" }, 42),
    );
    const r = resp.result as any;
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0].frameId).toBe(65);
    expect(r.elements.every((e: any) => e.frameId === 65)).toBe(true);
  });

  it("cross-origin scan failure marks frame as scanned=false with 0 elements", async () => {
    const execute = stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a/" },
        { frameId: 99, parentFrameId: 0, url: "https://a/xframe" },
      ],
      scanResults: {
        0: mkPage([{ selector: "button.top" }]),
        99: null, // claim 成功后让真实 scan 抛错（跨源 / 销毁）
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-same-origin" }, 42),
    );
    const r = resp.result as any;
    expect(r.frames).toHaveLength(2);
    const bad = r.frames.find((f: any) => f.frameId === 99);
    expect(bad).toMatchObject({ scanned: false, elementCount: 0 });
    const claim = execute.mock.calls.findIndex(([call]) => call.target.documentIds?.[0] === "doc-99" && call.args?.[0] === "scan.claim");
    expect(claim).toBeGreaterThanOrEqual(0);
    expect((await execute.mock.results[claim].value)[0]).toMatchObject({ frameId: 99, documentId: "doc-99", result: true });
    const win = execute.documents.get(99)!.window as any;
    expect(execute.scanFailures).toEqual([expect.objectContaining({ frameId: 99, documentId: "doc-99", scanned: true, retired: false })]);
    expect(win.document.__vortexScanOwner).toMatchObject({ documentId: "doc-99", retired: true });
  });

  it("throws IFRAME_NOT_READY when no target frames resolvable", async () => {
    stubChrome({
      frames: [],
      scanResults: {},
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    expect(resp.error?.code).toBe(VtxErrorCode.IFRAME_NOT_READY);
  });
});
