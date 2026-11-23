import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { updateScanOwnership } from "../src/handlers/observe-scan-ownership.js";
import { markListenerElements } from "../src/handlers/observe-js-listener.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/handlers/observe-js-listener.js", () => ({ markListenerElements: vi.fn().mockResolvedValue({ mechanism: "domDebugger" }) }));

const windows: JSDOM["window"][] = [];

/**
 * 归属 claim 失败的回归 harness：帧 0(主) / 9(父) / 17(子)，执行真实的生产注入函数。
 * 失效 documentId 的注入返回空数组（与浏览器一致），不会抛错。
 */
function setup() {
  let version = 0;
  const frames = new Map<number, { frameId: number; parentFrameId: number; documentId: string; url: string; win: any }>();
  const makeFrame = (frameId: number, parentFrameId: number, url: string) => {
    const dom = new JSDOM(`<!doctype html><body><button id="btn">DOM ${frameId} 0</button><div id="host"></div></body>`, {
      url, pretendToBeVisual: true, runScripts: "outside-only",
    });
    windows.push(dom.window);
    const win = dom.window as any;
    win.Date.now = () => Date.now();
    win.CSS = { escape: (value: string) => value };
    win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
    win.Element.prototype.scrollIntoView = () => {};
    win.document.elementFromPoint = () => null;
    win.document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = `<button id="shadow">Shadow ${frameId}</button>`;
    const frame = { frameId, parentFrameId, documentId: `document-${frameId}-${++version}`, url, win };
    frames.set(frameId, frame);
    return frame;
  };
  makeFrame(0, -1, "https://main.example/");
  makeFrame(9, 0, "https://main.example/parent");
  makeFrame(17, 9, "https://child.example/same");
  const listeners: Array<(event: any) => void> = [];
  const hooks: {
    beforeInjection?: (details: any) => Promise<void> | void;
    ownership?: (details: any) => boolean;
    afterInjection?: (details: any, frameId: number, result: unknown) => void;
  } = {};
  const navigate = (frameId: number) => {
    const old = frames.get(frameId)!;
    const descendants = (id: number): number[] => [id, ...[...frames.values()].filter((f) => f.parentFrameId === id).flatMap((f) => descendants(f.frameId))];
    const replaced = descendants(frameId).map((id) => frames.get(id)!);
    for (const frame of replaced) makeFrame(frame.frameId, frame.parentFrameId, frame.url);
    listeners.forEach((listener) => listener({ tabId: 42, frameId, documentId: frames.get(frameId)!.documentId, url: old.url }));
    return old;
  };
  const inject = async (details: any) => {
    const { target, func, args = [] } = details;
    const selected = [...frames.values()].filter((f) => target.documentIds
      ? target.documentIds.includes(f.documentId)
      : target.allFrames || (target.frameIds ?? [0]).includes(f.frameId));
    const results = [];
    for (const frame of selected) {
      const result = typeof func === "function" ? await frame.win.eval(`(${String(func)})`)(...structuredClone(args)) : undefined;
      hooks.afterInjection?.(details, frame.frameId, result);
      results.push({ frameId: frame.frameId, documentId: frame.documentId, result });
    }
    return results;
  };
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [...frames.values()].map(({ win: _win, ...frame }) => ({ ...frame, documentLifecycle: "active" }))),
      onCommitted: { addListener: (listener: (event: any) => void) => listeners.push(listener) },
      onHistoryStateUpdated: { addListener: (listener: (event: any) => void) => listeners.push(listener) },
    },
    runtime: { getManifest: () => ({ host_permissions: ["<all_urls>"] }) },
    scripting: { executeScript: vi.fn(async (details: any) => {
      await hooks.beforeInjection?.(details);
      return hooks.ownership?.(details) ? [] : inject(details);
    }) },
  });
  const debuggerMgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(async () => ({ nodes: [] })),
  };
  const router = new ActionRouter();
  registerObserveHandlers(router, debuggerMgr as any);
  const observe = (args: Record<string, unknown> = {}) => router.dispatch({
    type: "tool_request", tool: "observe.snapshot",
    args: { frameId: 17, includeAX: false, ...args }, requestId: "claim-failure", tabId: 42,
  });
  const commit = (frameId: number, documentId?: string) =>
    listeners.forEach((listener) => listener({ tabId: 42, frameId, documentId }));
  const frameIdOf = (documentId?: string) => [...frames.values()].find((f) => f.documentId === documentId)?.frameId;
  /** 用另一个 epoch 的存活租约占住该 frame，使 claim 被协议拒绝。 */
  const seedLiveOwner = async (frameId: number) => {
    const documentId = frames.get(frameId)!.documentId;
    await inject({
      target: { documentIds: [documentId] },
      func: updateScanOwnership,
      args: ["scan.claim", { epoch: "seed-epoch", order: 1, token: "seed-token", deadline: Date.now() + 60_000, frameId, documentId, ancestorFrameIds: [] }],
    });
  };
  return { frames, hooks, navigate, commit, inject, observe, frameIdOf, seedLiveOwner };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(markListenerElements).mockReset();
  vi.mocked(markListenerElements).mockResolvedValue({ mechanism: "domDebugger" });
  windows.splice(0).forEach((win) => win.close());
});

describe("observe scan ownership claim failures", () => {
  it("T1 retries once when the first claim injection throws", async () => {
    const api = setup();
    let claims = 0;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] !== "scan.claim") return;
      claims++;
      if (claims === 1) throw new Error('Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.');
    };
    const response: any = await api.observe();
    expect(claims).toBe(2);
    expect(response.error).toBeUndefined();
    expect(response.result.elements.length).toBeGreaterThan(0);
  });

  it("T2 reports the browser error when every claim injection throws", async () => {
    const api = setup();
    let claims = 0;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] !== "scan.claim") return;
      claims++;
      throw new Error('Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.');
    };
    const response: any = await api.observe();
    expect(claims).toBe(2);
    expect(response.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(response.error?.message).toContain("Cannot access contents of url");
    expect(response.error?.code).not.toBe("STALE_SNAPSHOT");
  });

  it("T3 reports the page as not ready when the claim returns no result", async () => {
    const api = setup();
    api.hooks.ownership = (details) => details.args?.[0] === "scan.claim";
    const response: any = await api.observe();
    expect(response.error?.code).toBe("PAGE_NOT_READY");
    expect(response.error?.message).toContain("no longer available");
  });

  it("T4 keeps the second round owner when the first claim injection is late", async () => {
    const api = setup();
    let claims = 0;
    const tagged = new Map<any, number>();
    let release!: () => void;
    const hung = new Promise<void>((resolve) => { release = resolve; });
    let lateResult: unknown;
    let ownerAfterSecond: any;
    api.hooks.beforeInjection = async (details) => {
      if (details.args?.[0] !== "scan.claim") return;
      const index = ++claims;
      tagged.set(details, index);
      if (index === 1) await hung;
    };
    api.hooks.afterInjection = (details, frameId, result) => {
      const index = tagged.get(details);
      if (index === 1) lateResult = result;
      if (index === 2) {
        ownerAfterSecond = { ...api.frames.get(frameId)!.win.document.__vortexScanOwner };
        release();
      }
    };
    const response: any = await api.observe();
    expect(claims).toBe(2);
    expect(response.error).toBeUndefined();
    expect(lateResult).toBe(false);
    expect(ownerAfterSecond?.owner).toBeTruthy();
    expect(ownerAfterSecond?.retired).toBe(false);
  }, 10_000);

  it("T5 reports a refused ownership claim as a stale snapshot", async () => {
    const api = setup();
    await api.seedLiveOwner(17);
    const response: any = await api.observe();
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.error?.message).toContain("ownership protocol refused");
  });

  it("T6 reports the main frame as not ready when its document is not active", async () => {
    const api = setup();
    vi.mocked(chrome.webNavigation.getAllFrames).mockImplementation(async () =>
      [...api.frames.values()].map(({ win: _win, ...frame }) => ({ ...frame, documentLifecycle: "pending_commit" })));
    const response: any = await api.observe({ frameId: 0 });
    expect(response.error?.code).toBe("PAGE_NOT_READY");
    expect(response.error?.message).toContain("not ready");
  });

  it("T7 observes the new document when the target document is replaced in the first round", async () => {
    const api = setup();
    const oldDocumentId = api.frames.get(17)!.documentId;
    api.commit(17, oldDocumentId);
    let navigated = false;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] === "scan.claim" && !navigated) {
        navigated = true;
        api.navigate(17);
      }
    };
    const response: any = await api.observe();
    expect(response.error).toBeUndefined();
    expect(api.frames.get(17)!.documentId).not.toBe(oldDocumentId);
  });

  it("T8 observes the new document when an ancestor frame navigates in the first round", async () => {
    const api = setup();
    let navigated = false;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] === "scan.claim" && !navigated) {
        navigated = true;
        api.navigate(9);
      }
    };
    const response: any = await api.observe();
    expect(response.error).toBeUndefined();
  });

  it("T9 still rejects a navigation inside the second round capture window", async () => {
    const api = setup();
    let claims = 0;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] !== "scan.claim") return;
      claims++;
      if (claims === 1) throw new Error("transient injection failure");
    };
    let checkResult: unknown;
    let checked = false;
    api.hooks.afterInjection = (details, frameId, result) => {
      if (details.args?.[0] === "scan.check" && frameId === 17 && !checked) {
        checked = true;
        checkResult = result;
        api.navigate(17);
      }
    };
    const response: any = await api.observe();
    expect(claims).toBe(2);
    expect(checked).toBe(true);
    expect(checkResult).toBe(true);
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.error?.message).toContain("Document ownership changed before snapshot publication");
  });
});

describe("observe scan ownership failure classification", () => {
  it("P-b classifies a recovery failure as terminal and does not retry", async () => {
    const api = setup();
    await api.seedLiveOwner(17);
    let claims = 0;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] === "scan.claim") claims++;
      if (details.args?.[0] === "ownership.probe") throw new Error("probe injection failed");
    };
    const response: any = await api.observe();
    expect(claims).toBe(1);
    expect(response.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(response.error?.message).toContain("ownership recovery failed");
    expect(response.error?.message).toContain("probe injection failed");
  });

  it("P-c classifies a recovery timeout as terminal and does not retry", async () => {
    const api = setup();
    await api.seedLiveOwner(17);
    let claims = 0;
    api.hooks.beforeInjection = async (details) => {
      if (details.args?.[0] === "scan.claim") claims++;
      if (details.args?.[0] === "ownership.probe") await new Promise(() => {});
    };
    const response: any = await api.observe();
    expect(claims).toBe(1);
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.error?.message).toContain("ownership recovery timed out");
  }, 10_000);

  it("P-d prefers the terminal refusal over a retryable injection error", async () => {
    const api = setup();
    await api.seedLiveOwner(9);
    api.hooks.beforeInjection = (details) => {
      const frameId = api.frameIdOf(details.target?.documentIds?.[0]);
      if (details.args?.[0] === "scan.claim" && frameId === 0) throw new Error("injection blew up");
    };
    api.hooks.ownership = (details) => {
      const frameId = api.frameIdOf(details.target?.documentIds?.[0]);
      return details.args?.[0] === "scan.claim" && frameId === 17;
    };
    const response: any = await api.observe({ frameId: undefined, frames: "all" });
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.error?.message).toContain("ownership protocol refused");
    expect(response.error?.message).toContain("frame 9");
  });

  it("P-d prefers an injection error over an empty result", async () => {
    const api = setup();
    api.hooks.beforeInjection = (details) => {
      const frameId = api.frameIdOf(details.target?.documentIds?.[0]);
      if (details.args?.[0] === "scan.claim" && frameId === 0) throw new Error("injection blew up");
    };
    api.hooks.ownership = (details) => {
      const frameId = api.frameIdOf(details.target?.documentIds?.[0]);
      return details.args?.[0] === "scan.claim" && frameId !== 0;
    };
    const response: any = await api.observe({ frameId: undefined, frames: "all" });
    expect(response.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(response.error?.message).toContain("injection blew up");
  });

  it("P-e leaves no first round degradation behind after a successful retry", async () => {
    const api = setup();
    let claims = 0;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] !== "scan.claim") return;
      claims++;
      if (claims === 1) throw new Error("transient injection failure");
    };
    const response: any = await api.observe();
    expect(claims).toBe(2);
    expect(response.error).toBeUndefined();
    expect(response.result.meta.degraded).toBeUndefined();
  });

  it("P-f surfaces listener discovery failures as a degradation", async () => {
    const api = setup();
    vi.mocked(markListenerElements).mockRejectedValue(new Error("listener boom"));
    const response: any = await api.observe();
    expect(response.error).toBeUndefined();
    expect(response.result.meta.degraded?.listenerDiscovery).toBe("error");
  });
});
