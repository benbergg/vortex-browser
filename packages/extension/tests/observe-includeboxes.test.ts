// Issue #21 — SPEC R4/R5 + AC#5/#6.
// Handler-side payload gate: when input.includeBoxes=true, attach
// `bbox: [x,y,w,h]` tuple to each compact element that intersects
// the frame viewport AND has positive area. Otherwise the bbox key
// is omitted entirely from the payload.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";

type ScanElement = {
  index: number;
  tag: string;
  role: string;
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  visible: boolean;
  inViewport: boolean;
  attrs: Record<string, string>;
  _sel: string;
  state?: Record<string, boolean>;
};

function mkElem(overrides: Partial<ScanElement> = {}): ScanElement {
  return {
    index: 0,
    tag: "button",
    role: "button",
    name: "btn",
    bbox: { x: 100, y: 200, w: 50, h: 30 },
    visible: true,
    inViewport: true,
    attrs: {},
    _sel: "button",
    ...overrides,
  };
}

function mkPage(elements: ScanElement[]) {
  // Reindex sequentially so the handler's globalIdx maps cleanly.
  const reindexed = elements.map((e, i) => ({ ...e, index: i }));
  return {
    url: "https://x/",
    title: "T",
    viewport: { width: 1000, height: 800, scrollY: 0, scrollHeight: 800 },
    elements: reindexed,
    candidateCount: reindexed.length,
    truncated: false,
  };
}

function mkReq(args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return {
    type: "tool_request",
    tool: "observe.snapshot",
    args,
    requestId: "r-1",
    tabId,
  };
}

type FrameRow = { frameId: number; parentFrameId: number; url: string };

function stubChrome(opts: {
  frames: FrameRow[];
  scanResults: Record<number, ReturnType<typeof mkPage> | null>;
  /**
   * Offset lookup keyed by the **child frame URL** (iframe-offset.ts:39
   * passes the child frame's URL as args[0] while executeScript targets
   * the parent frame). Defaults to {0,0} for unmapped URLs.
   */
  offsetsByChildUrl?: Record<string, { x: number; y: number }>;
}) {
  const executeScript = vi.fn(
    async ({ target, args }: { target: { frameIds?: number[] }; args?: unknown[] }) => {
      const frameId = target.frameIds?.[0];
      // Offset-resolve calls pass a string url as args[0]
      const childUrl = args?.[0];
      if (typeof childUrl === "string" && childUrl.startsWith("http")) {
        const off = opts.offsetsByChildUrl?.[childUrl] ?? { x: 0, y: 0 };
        return [{ result: off }];
      }
      if (frameId == null) return [{ result: opts.scanResults[0] ?? null }];
      return [{ result: opts.scanResults[frameId] ?? null }];
    },
  );
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue(opts.frames),
    },
    scripting: { executeScript },
    runtime: {
      getManifest: vi.fn().mockReturnValue({
        host_permissions: ["<all_urls>"],
      }),
    },
  });
}

type CompactResult = {
  elements: Array<{
    index: number;
    tag: string;
    role: string;
    name: string;
    frameId: number;
    bbox?: [number, number, number, number];
    state?: Record<string, boolean>;
  }>;
  frames: Array<{
    frameId: number;
    offset: { x: number; y: number };
    scanned: boolean;
  }>;
};

describe("observe handler — includeBoxes payload gate (Issue #21)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("chrome", { webNavigation: {} });
    router = new ActionRouter();
    registerObserveHandlers(router);
  });

  it("C-H1: includeBoxes=true + visible element → element.bbox is tuple of integers", async () => {
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
      scanResults: {
        0: mkPage([
          mkElem({ bbox: { x: 100, y: 200, w: 50, h: 30 }, inViewport: true }),
        ]),
      },
    });
    const resp = await router.dispatch(
      mkReq({ format: "compact", includeBoxes: true }),
    );
    const r = resp.result as CompactResult;
    expect(r.elements[0].bbox).toEqual([100, 200, 50, 30]);
  });

  it("C-H2: includeBoxes=false (default) → element has no bbox field", async () => {
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
      scanResults: {
        0: mkPage([mkElem({ inViewport: true })]),
      },
    });
    const resp = await router.dispatch(mkReq({ format: "compact" }));
    const r = resp.result as CompactResult;
    expect(r.elements[0]).not.toHaveProperty("bbox");
  });

  it("C-H3: includeBoxes=true + inViewport=false → bbox omitted (off-screen rule)", async () => {
    // Pre-existing viewport='full' mode keeps off-screen elements in the
    // result; in that scenario bbox emission must be suppressed.
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
      scanResults: {
        0: mkPage([
          mkElem({
            name: "visible",
            inViewport: true,
            bbox: { x: 10, y: 20, w: 30, h: 40 },
          }),
          mkElem({
            name: "offscreen",
            inViewport: false,
            bbox: { x: -200, y: -100, w: 50, h: 30 },
          }),
        ]),
      },
    });
    const resp = await router.dispatch(
      mkReq({ format: "compact", viewport: "full", includeBoxes: true }),
    );
    const r = resp.result as CompactResult;
    expect(r.elements).toHaveLength(2);
    expect(r.elements[0].bbox).toEqual([10, 20, 30, 40]);
    expect(r.elements[1]).not.toHaveProperty("bbox");
  });

  it("C-H4: includeBoxes=true + zero-width or zero-height → bbox omitted", async () => {
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
      scanResults: {
        0: mkPage([
          mkElem({ name: "zw", inViewport: true, bbox: { x: 5, y: 5, w: 0, h: 30 } }),
          mkElem({ name: "zh", inViewport: true, bbox: { x: 5, y: 5, w: 30, h: 0 } }),
          mkElem({ name: "ok", inViewport: true, bbox: { x: 5, y: 5, w: 30, h: 30 } }),
        ]),
      },
    });
    const resp = await router.dispatch(
      mkReq({ format: "compact", viewport: "full", includeBoxes: true }),
    );
    const r = resp.result as CompactResult;
    expect(r.elements[0]).not.toHaveProperty("bbox");
    expect(r.elements[1]).not.toHaveProperty("bbox");
    expect(r.elements[2].bbox).toEqual([5, 5, 30, 30]);
  });

  it("C-H5: includeBoxes=true + float bbox → values rounded with Math.round", async () => {
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
      scanResults: {
        0: mkPage([
          mkElem({
            inViewport: true,
            bbox: { x: 100.7, y: 200.3, w: 50.5, h: 30.4 },
          }),
        ]),
      },
    });
    const resp = await router.dispatch(
      mkReq({ format: "compact", includeBoxes: true }),
    );
    const r = resp.result as CompactResult;
    // Math.round: 100.7→101, 200.3→200, 50.5→51 (banker's half-to-even
    // would yield 50, but JS Math.round rounds half away from zero → 51),
    // 30.4→30
    expect(r.elements[0].bbox).toEqual([101, 200, 51, 30]);
  });

  it("C-H6: includeBoxes=true + iframe element → bbox is frame-local; frame offset preserved in framesOut", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://top.example/" },
        { frameId: 7, parentFrameId: 0, url: "https://child.example/" },
      ],
      scanResults: {
        0: mkPage([mkElem({ bbox: { x: 100, y: 200, w: 50, h: 30 } })]),
        7: mkPage([mkElem({ bbox: { x: 10, y: 20, w: 40, h: 25 } })]),
      },
      offsetsByChildUrl: {
        "https://child.example/": { x: 300, y: 150 },
      },
    });
    const resp = await router.dispatch(
      mkReq({ format: "compact", frames: "all-permitted", includeBoxes: true }),
    );
    const r = resp.result as CompactResult;
    // Main element keeps its coords
    const mainEl = r.elements.find((e) => e.frameId === 0)!;
    expect(mainEl.bbox).toEqual([100, 200, 50, 30]);
    // Iframe element coords stay frame-local (NOT top-page composed)
    const iframeEl = r.elements.find((e) => e.frameId === 7)!;
    expect(iframeEl.bbox).toEqual([10, 20, 40, 25]);
    // Frame offset is preserved in framesOut so the renderer can emit the
    // `# frame N offset=[x,y]` meta line (proved by the render-side test).
    const childFrame = r.frames.find((f) => f.frameId === 7)!;
    expect(childFrame.offset).toEqual({ x: 300, y: 150 });
  });

  it("C-H7: default-off baseline parity — payload byte-equal whether includeBoxes is undefined or false", async () => {
    // The bbox key omission must be total: serialized output should match
    // byte-for-byte between `undefined` and explicit `false`.
    const setup = () => {
      stubChrome({
        frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
        scanResults: {
          0: mkPage([mkElem(), mkElem({ name: "two" }), mkElem({ name: "three" })]),
        },
      });
    };

    setup();
    const respUndef = await router.dispatch(mkReq({ format: "compact" }));

    setup();
    const respFalse = await router.dispatch(
      mkReq({ format: "compact", includeBoxes: false }),
    );

    // meta.autoFallback etc may differ in irrelevant ways across runs of
    // the mock; compare only the elements array, which is what callers
    // serialize for token budgeting.
    const aEls = (respUndef.result as CompactResult).elements;
    const bEls = (respFalse.result as CompactResult).elements;
    expect(JSON.stringify(aEls)).toBe(JSON.stringify(bEls));
    expect(JSON.stringify(aEls)).not.toContain('"bbox"');
  });

  it("C-H8: non-boolean includeBoxes values are rejected (strict === true)", async () => {
    // Mirrors server.ts:348. A misconfigured caller sending a stringy or
    // numeric truthy value must NOT silently flip emission on; otherwise
    // the compact-text renderer (which uses strict ===) and the JSON
    // payload disagree about whether bbox is present.
    const stringyArgs = { format: "compact", includeBoxes: "true" as unknown as boolean };
    const numericArgs = { format: "compact", includeBoxes: 1 as unknown as boolean };
    const objectArgs = { format: "compact", includeBoxes: {} as unknown as boolean };

    for (const args of [stringyArgs, numericArgs, objectArgs]) {
      stubChrome({
        frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
        scanResults: { 0: mkPage([mkElem({ inViewport: true })]) },
      });
      const resp = await router.dispatch(mkReq(args));
      const r = resp.result as CompactResult;
      expect(r.elements[0]).not.toHaveProperty("bbox");
    }
  });
});
