import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";

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

function mkPage(elements: Array<{ selector: string }>) {
  return {
    url: "https://x/",
    title: "T",
    viewport: { width: 1000, height: 800, scrollY: 0, scrollHeight: 800 },
    elements: elements.map((e, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: "",
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
      inViewport: true,
      attrs: {},
      _sel: e.selector,
    })),
    candidateCount: elements.length,
    truncated: false,
  };
}

function stubChrome(opts: {
  frames: FrameRow[];
  scanResults: Record<number, any>;
  hostPermissions?: string[];
}) {
  const frames = opts.frames.map((frame) => ({ ...frame, documentId: `doc-${frame.frameId}` }));
  const documents = new Map<number, JSDOM>();
  for (const frame of frames) {
    const dom = new JSDOM("<!doctype html><body></body>", { url: frame.url, runScripts: "outside-only", pretendToBeVisual: true });
    documents.set(frame.frameId, dom);
    realms.push(dom);
    const win = dom.window as any;
    win.CSS = { escape: String };
    win.document.elementFromPoint = () => null;
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
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
      const offset = { x: 0, y: 0 };
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
    if (opts.scanResults[frame.frameId] === null) return [{ frameId: frame.frameId, documentId: frame.documentId, result: null }];
    const win = documents.get(frame.frameId)!.window as any;
    const result = win.eval(`(${String(func)})`)(...structuredClone(args));
    if (Array.isArray(result?.elements)) {
      // Preserve fixture selectors for routing assertions, not CSS path generation.
      result.elements.forEach((element: any, index: number) => { element._sel = opts.scanResults[frame.frameId].elements[index]._sel; });
    }
    return [{ frameId: frame.frameId, documentId: frame.documentId, result }];
  });
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue(frames),
    },
    scripting: { executeScript },
    runtime: {
      getManifest: vi.fn().mockReturnValue({
        host_permissions: opts.hostPermissions ?? ["<all_urls>"],
      }),
    },
  });
}

describe("observe frames: 'all-permitted' (@since 0.4.0 O-6)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("chrome", { webNavigation: {} });
    router = new ActionRouter();
    registerObserveHandlers(router);
  });

  it("with host_permissions=<all_urls>: includes cross-origin frames that all-same-origin would skip", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a.io/" },
        { frameId: 22, parentFrameId: 0, url: "https://sub.b.io/app" },
      ],
      scanResults: {
        0: mkPage([{ selector: "button.top" }]),
        22: mkPage([{ selector: "button.sub" }]),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-permitted" }, 42),
    );
    const r = resp.result as any;
    // 跨 origin 的 frame 22 应被扫到
    expect(r.frames.map((f: any) => f.frameId).sort()).toEqual([0, 22]);
    expect(r.elements.map((e: any) => e.frameId).sort()).toEqual([0, 22]);
  });

  it("with restricted host_permissions: only matching origins are scanned", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a.io/" },
        { frameId: 22, parentFrameId: 0, url: "https://whitelisted.example/" },
        { frameId: 33, parentFrameId: 0, url: "https://blocked.other/" },
      ],
      scanResults: {
        0: mkPage([{ selector: "a" }]),
        22: mkPage([{ selector: "b" }]),
        33: mkPage([{ selector: "c" }]),
      },
      hostPermissions: [
        "https://a.io/*",
        "https://*.example/*",
      ],
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-permitted" }, 42),
    );
    const r = resp.result as any;
    expect(r.frames.map((f: any) => f.frameId).sort()).toEqual([0, 22]);
    // 33 blocked.other 不在 host_permissions，不应出现
    const ids = r.frames.map((f: any) => f.frameId);
    expect(ids).not.toContain(33);
  });

  it("skips non-HTTP(S) frames (chrome:// / about:blank) even under <all_urls>", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a.io/" },
        { frameId: 22, parentFrameId: 0, url: "about:blank" },
        { frameId: 33, parentFrameId: 0, url: "chrome://newtab/" },
      ],
      scanResults: {
        0: mkPage([{ selector: "a" }]),
        22: mkPage([{ selector: "b" }]),
        33: mkPage([{ selector: "c" }]),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-permitted" }, 42),
    );
    const r = resp.result as any;
    // 只主 frame 被 scan
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].frameId).toBe(0);
  });

  it("coexists with 'all-same-origin' (still strict) and 'all' (unfiltered)", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://a.io/" },
        { frameId: 22, parentFrameId: 0, url: "https://b.io/" },
      ],
      scanResults: {
        0: mkPage([{ selector: "a" }]),
        22: mkPage([{ selector: "b" }]),
      },
      hostPermissions: ["<all_urls>"],
    });

    const sameOrigin = (await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-same-origin" }, 42),
    )).result as any;
    const permitted = (await router.dispatch(
      mkReq("observe.snapshot", { frames: "all-permitted" }, 42),
    )).result as any;
    const all = (await router.dispatch(
      mkReq("observe.snapshot", { frames: "all" }, 42),
    )).result as any;

    expect(sameOrigin.frames.map((f: any) => f.frameId)).toEqual([0]);
    expect(permitted.frames.map((f: any) => f.frameId).sort()).toEqual([0, 22]);
    expect(all.frames.map((f: any) => f.frameId).sort()).toEqual([0, 22]);
  });
});
