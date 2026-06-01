import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@bytenew/vortex-shared";
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

type FrameRow = { frameId: number; parentFrameId: number; url: string };

function mkPage(elementCount: number) {
  return {
    url: "https://x/",
    title: "T",
    viewport: { width: 1000, height: 800, scrollY: 0, scrollHeight: 800 },
    elements: Array.from({ length: elementCount }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: `el${i}`,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
      inViewport: true,
      attrs: {},
      _sel: `button[data-i="${i}"]`,
    })),
    candidateCount: elementCount,
    truncated: false,
  };
}

function stubChrome(opts: {
  frames: FrameRow[];
  scanResults: Record<number, ReturnType<typeof mkPage> | null>;
}) {
  const executeScript = vi.fn(async ({ target, args }: { target: { frameIds?: number[] }; args?: unknown[] }) => {
    const frameId = target.frameIds?.[0];
    if (frameId == null) return [{ result: opts.scanResults[0] ?? null }];
    const childUrl = args?.[0];
    if (typeof childUrl === "string" && childUrl.startsWith("http")) {
      return [{ result: { x: 0, y: 0 } }];
    }
    return [{ result: opts.scanResults[frameId] ?? null }];
  });
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

describe("observe auto-fallback (shell+iframe sites)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    registerObserveHandlers(router);
  });

  it("triggers fallback: caller omits frames, main has < 50 interactive, child iframe exists → scans iframe and sets autoFallback=true", async () => {
    // Mimics Zentao: main frame is shell with 14 nav links, content is in iframe
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://chandao.example/my.html" },
        { frameId: 190, parentFrameId: 0, url: "https://chandao.example/my-task.html" },
      ],
      scanResults: {
        0: mkPage(14),
        190: mkPage(50),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as { frames: Array<{ frameId: number }>; elements: unknown[]; meta: { autoFallback?: true } };
    // Should now include iframe content
    expect(r.frames.map((f) => f.frameId).sort()).toEqual([0, 190]);
    expect(r.elements.length).toBe(64);
    expect(r.meta.autoFallback).toBe(true);
  });

  it("does NOT trigger when caller explicitly passes frames='main'", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/iframe" },
      ],
      scanResults: {
        0: mkPage(5),
        190: mkPage(50),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frames: "main" }, 42),
    );
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    expect(r.frames.map((f) => f.frameId)).toEqual([0]);
    expect(r.meta.autoFallback).toBeUndefined();
  });

  it("does NOT trigger when main has >= threshold (50) interactive elements", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://spa.example/" },
        { frameId: 190, parentFrameId: 0, url: "https://spa.example/widget" },
      ],
      scanResults: {
        0: mkPage(100),
        190: mkPage(10),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    expect(r.frames.map((f) => f.frameId)).toEqual([0]);
    expect(r.meta.autoFallback).toBeUndefined();
  });

  it("does NOT trigger when no child iframe exists (single-frame page)", async () => {
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://small.example/" }],
      scanResults: { 0: mkPage(3) },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    expect(r.frames.map((f) => f.frameId)).toEqual([0]);
    expect(r.meta.autoFallback).toBeUndefined();
  });

  it("does NOT trigger when caller explicitly sets filter='all'", async () => {
    // filter='all' is explicit caller intent (e.g. token budget audit) — should
    // never auto-expand frames silently.
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/iframe" },
      ],
      scanResults: {
        0: mkPage(5),
        190: mkPage(50),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { filter: "all" }, 42),
    );
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    expect(r.frames.map((f) => f.frameId)).toEqual([0]);
    expect(r.meta.autoFallback).toBeUndefined();
  });

  it("does NOT trigger when main scan failed (page=null) — preserves real error instead of silent fallback", async () => {
    // Mimic main scan failure (cross-origin rejection / frame destroyed mid-scan).
    // executeScript returns null result for main, but webNavigation lists the
    // frames. Without the guard, page=null would yield elementCount=0 < 50 and
    // silently fallback to iframe content, masking the main scan failure.
    const executeScript = vi.fn(async ({ target, args }: { target: { frameIds?: number[] }; args?: unknown[] }) => {
      const frameId = target.frameIds?.[0];
      const childUrl = args?.[0];
      if (typeof childUrl === "string" && childUrl.startsWith("http")) {
        return [{ result: { x: 0, y: 0 } }];
      }
      // main fails; child has content
      if (frameId === 0) return [{ result: null }];
      if (frameId === 190) return [{ result: mkPage(50) }];
      return [{ result: null }];
    });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://shell/" },
          { frameId: 190, parentFrameId: 0, url: "https://shell/iframe" },
        ]),
      },
      scripting: { executeScript },
      runtime: {
        getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as { frames: Array<{ scanned: boolean; frameId: number }>; meta: { autoFallback?: true } };
    // Should NOT auto-fallback to iframe
    expect(r.meta.autoFallback).toBeUndefined();
    // main frame is reported as scanned=false
    const main = r.frames.find((f) => f.frameId === 0);
    expect(main?.scanned).toBe(false);
  });

  it("triggers at boundary: main has exactly 49 elements (just below threshold=50)", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://shell/" },
        { frameId: 190, parentFrameId: 0, url: "https://shell/iframe" },
      ],
      scanResults: {
        0: mkPage(49),
        190: mkPage(30),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    expect(r.frames.map((f) => f.frameId).sort()).toEqual([0, 190]);
    expect(r.meta.autoFallback).toBe(true);
  });

  it("does NOT trigger at boundary: main has exactly 50 elements (at threshold)", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://shell/" },
        { frameId: 190, parentFrameId: 0, url: "https://shell/iframe" },
      ],
      scanResults: {
        0: mkPage(50),
        190: mkPage(30),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    expect(r.frames.map((f) => f.frameId)).toEqual([0]);
    expect(r.meta.autoFallback).toBeUndefined();
  });

  it("does NOT trigger when explicit frameId is set", async () => {
    // explicit frameId means caller wants exactly this frame, don't expand
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/iframe" },
      ],
      scanResults: {
        0: mkPage(50),
        190: mkPage(2),
      },
    });
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frameId: 190 }, 42),
    );
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    expect(r.frames.map((f) => f.frameId)).toEqual([190]);
    expect(r.meta.autoFallback).toBeUndefined();
  });

  it("respects host_permissions when falling back: cross-origin iframes outside permissions are skipped", async () => {
    // Verify that auto-fallback uses 'all-permitted' (not 'all'), so blocked
    // origins still excluded
    const executeScript = vi.fn(async ({ target, args }: { target: { frameIds?: number[] }; args?: unknown[] }) => {
      const frameId = target.frameIds?.[0];
      const childUrl = args?.[0];
      if (typeof childUrl === "string" && childUrl.startsWith("http")) {
        return [{ result: { x: 0, y: 0 } }];
      }
      const pages: Record<number, ReturnType<typeof mkPage>> = {
        0: mkPage(5),
        190: mkPage(30),
        191: mkPage(40),
      };
      return [{ result: frameId != null ? pages[frameId] ?? null : null }];
    });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://shell.example/" },
          { frameId: 190, parentFrameId: 0, url: "https://shell.example/app" },
          { frameId: 191, parentFrameId: 0, url: "https://blocked.other/" },
        ]),
      },
      scripting: { executeScript },
      runtime: {
        getManifest: vi.fn().mockReturnValue({
          host_permissions: ["https://shell.example/*"],
        }),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as { frames: Array<{ frameId: number }>; meta: { autoFallback?: true } };
    // 191 (blocked.other) should NOT be scanned even when fallback triggers
    const ids = r.frames.map((f) => f.frameId).sort();
    expect(ids).toEqual([0, 190]);
    expect(r.meta.autoFallback).toBe(true);
  });

  it("falls back into a same-origin srcdoc iframe (about:srcdoc child)", async () => {
    // srcdoc inherits its parent's origin, but its frame URL is the opaque
    // `about:srcdoc`, which isFrameInPermissions() rejects (non-http). The
    // judge `iframe-srcdoc-inherit` fixture exposed this: auto-fallback dropped
    // the srcdoc child, so observe never reported the child button. Same-origin
    // srcdoc must be scanned just like resolveTargetFrames('all-same-origin').
    const executeScript = vi.fn(
      async ({ target, args }: { target: { frameIds?: number[] }; args?: unknown[] }) => {
        const frameId = target.frameIds?.[0];
        // getIframeOffset passes the child frame url (string) → return a rect
        if (typeof args?.[0] === "string") return [{ result: { x: 0, y: 0 } }];
        // scan call (args[0] is max:number) → page for this frame
        const pages: Record<number, ReturnType<typeof mkPage>> = {
          0: mkPage(1),
          1: mkPage(1),
        };
        return [{ result: frameId != null ? pages[frameId] ?? null : null }];
      },
    );
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://example.com/page" },
          { frameId: 1, parentFrameId: 0, url: "about:srcdoc" },
        ]),
      },
      scripting: { executeScript },
      runtime: {
        getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }),
      },
    });
    const resp = await router.dispatch(mkReq("observe.snapshot", {}, 42));
    const r = resp.result as {
      frames: Array<{ frameId: number }>;
      elements: unknown[];
      meta: { autoFallback?: true };
    };
    // srcdoc child (frameId 1) must be included via inherited same-origin
    expect(r.frames.map((f) => f.frameId).sort()).toEqual([0, 1]);
    expect(r.elements.length).toBe(2);
    expect(r.meta.autoFallback).toBe(true);
  });
});
