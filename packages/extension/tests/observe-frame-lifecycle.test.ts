import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";

// The debugger response is controlled here; real Chrome frame/target mapping and
// OOPIF routing still require an extension running in a multi-process browser.
vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/handlers/observe-js-listener.js", () => ({
  markListenerElements: vi.fn().mockResolvedValue({ mechanism: "domDebugger" }),
}));

const windows: JSDOM["window"][] = [];

function setup(holdAX = true) {
  let onCommitted: ((details: any) => void) | undefined;
  let release!: () => void;
  let enteredAX!: () => void;
  const entered = new Promise<void>((resolve) => { enteredAX = resolve; });
  const ax = new Promise<void>((resolve) => { release = resolve; });
  const frames = new Map<number, { frameId: number; parentFrameId: number; documentId: string; url: string; win: any; axName: string }>();
  const makeFrame = (frameId: number, documentId: string, url: string, name: string, axName: string) => {
    const dom = new JSDOM(`<!doctype html><body><button id="b0"></button></body>`, { url, pretendToBeVisual: true, runScripts: "outside-only" });
    windows.push(dom.window);
    const win = dom.window as any;
    win.document.querySelector("button").textContent = name;
    win.CSS = { escape: (value: string) => value };
    win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
    win.Element.prototype.scrollIntoView = () => {};
    win.document.elementFromPoint = () => null;
    const frame = { frameId, parentFrameId: frameId === 0 ? -1 : 0, documentId, url, win, axName };
    frames.set(frameId, frame);
    return frame;
  };
  makeFrame(0, "main-old", "https://main.example/old", "DOM old", "STALE AX");
  const hooks: { afterInjection?: (details: any, result: any) => void } = {};
  // Route like Chrome, then execute serialized production code in the selected realm.
  const inject = async (details: any) => {
    const { target, func, args = [] } = details;
    const selected = [...frames.values()].filter((frame) => target.documentIds
      ? target.documentIds.includes(frame.documentId) : target.allFrames || (target.frameIds ?? [0]).includes(frame.frameId));
    const results = [];
    for (const frame of selected) {
      const result = await frame.win.eval(`(${String(func)})`)(...structuredClone(args));
      hooks.afterInjection?.(details, result);
      results.push({ frameId: frame.frameId, documentId: frame.documentId, result });
    }
    return results;
  };
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [...frames.values()].map(({ frameId, parentFrameId, documentId, url }) => ({ frameId, parentFrameId, documentId, url, documentLifecycle: "active" }))),
      onCommitted: { addListener: (fn: typeof onCommitted) => { onCommitted = fn; } },
    },
    runtime: { getManifest: () => ({ host_permissions: ["<all_urls>"] }) },
    scripting: { executeScript: vi.fn(inject) },
  });
  const backendIds = new WeakMap<object, number>();
  let nextBackend = 100;
  const backendId = (node: object) => {
    if (!backendIds.has(node)) backendIds.set(node, ++nextBackend);
    return backendIds.get(node)!;
  };
  const project = (node: any): any => ({
    nodeName: node.nodeName, backendNodeId: backendId(node),
    attributes: node.attributes ? Array.from(node.attributes).flatMap((attr: any) => [attr.name, attr.value]) : [],
    children: Array.from(node.children ?? []).map(project),
  });
  const cdpDocument = () => {
    const root = project(frames.get(0)!.win.document);
    root.children.push(...[...frames.values()].filter((frame) => frame.frameId !== 0).map((frame) => ({
      nodeName: "IFRAME", frameId: `CDP-${frame.frameId}`, contentDocument: project(frame.win.document),
    })));
    return root;
  };
  const debuggerMgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(async (_tab: number, method: string, params?: any) => {
      if (method === "DOM.getDocument") return { root: cdpDocument() };
      if (method === "Accessibility.getFullAXTree") {
        const frame = frames.get(Number(params?.frameId?.slice(4) ?? 0))!;
        const nodes = Array.from(frame.win.document.querySelectorAll("[data-vtx-ax]")).map((el: any) => ({
          nodeId: String(backendId(el)), backendDOMNodeId: backendId(el), role: { value: "button" }, name: { value: frame.axName },
        }));
        enteredAX();
        if (holdAX) await ax;
        return { nodes };
      }
      return {};
    }),
  };
  const router = new ActionRouter();
  registerObserveHandlers(router, debuggerMgr as any);
  const observe = (includeAX = true, frameId = 0) => router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: frameId === 0 ? { frames: "main", includeAX } : { frameId, includeAX }, requestId: "lifecycle", tabId: 42 });
  const commit = (frameId = 0) => {
    expect(onCommitted).toBeTypeOf("function");
    const frame = frames.get(frameId)!;
    onCommitted!({ tabId: 42, frameId, documentId: frame.documentId, url: frame.url });
  };
  const navigate = () => {
    makeFrame(0, "main-new", "https://main.example/new", "DOM new", "New AX");
    commit();
  };
  return { observe, entered, release, navigate, commit, frames, makeFrame, hooks, inject };
}
afterEach(() => {
  for (const win of windows.splice(0)) win.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AX capture lifecycle", () => {
  it("applies AX on a stable document", async () => {
    const { observe, entered, release } = setup();
    const pending = observe();
    await entered;
    release();
    const response: any = await pending;
    expect(response.error).toBeUndefined();
    expect(response.result.elements[0].name).toBe("STALE AX");
  });

  it("executes ownership injections and rejects a claim replay after retirement", async () => {
    const api = setup();
    const doc = api.frames.get(0)!.win.document;
    const operations: Array<{ action: string; result: unknown; token: string; owner: string | null; frameMarker: string | null; marker: string | null }> = [];
    api.hooks.afterInjection = (details, result) => {
      const action = details.args?.[0];
      if (["claim", "check", "retire"].includes(action)) operations.push({
        action, result, token: details.args[1].token, owner: doc.__vortexAXOwner?.owner,
        frameMarker: doc.documentElement.getAttribute("data-vtx-frame-ax"), marker: doc.querySelector("#b0").getAttribute("data-vtx-ax"),
      });
    };
    const pending = api.observe();
    await api.entered;
    api.release();
    const response: any = await pending;
    expect(response.result.elements[0].name).toBe("STALE AX");
    api.hooks.afterInjection = undefined;
    expect(operations.map((operation) => operation.action)).toEqual(["claim", "check", "retire"]);
    const [claimed, checked, retired] = operations;
    expect(claimed).toMatchObject({ result: true, owner: claimed.token });
    expect(checked).toMatchObject({ result: true, owner: claimed.token, frameMarker: claimed.token, marker: `${claimed.token}:0` });
    expect(retired).toMatchObject({ result: true, owner: null, frameMarker: null, marker: null });
    const calls = vi.mocked(chrome.scripting.executeScript).mock.calls.map(([details]: any) => details);
    const claim = calls.find((details) => details.args?.[0] === "claim");
    const replay = await chrome.scripting.executeScript(claim);
    expect(replay).toMatchObject([{ frameId: 0, documentId: "main-old", result: false }]);
    const check = calls.find((details) => details.args?.[0] === "check");
    expect(await api.inject(check)).toMatchObject([{ frameId: 0, documentId: "main-old", result: false }]);
  });

  it("does not apply a stale AX response after navigation", async () => {
    const api = setup();
    const pending = api.observe();
    await api.entered;
    api.navigate();
    const replacement = api.frames.get(0)!;
    api.release();
    const response: any = await pending;
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.result).toBeUndefined();
    expect(replacement.win.document.__vortexAXOwner).toBeUndefined();
    const calls = vi.mocked(chrome.scripting.executeScript).mock.calls.map(([details]: any) => details);
    const ownedCalls = calls.filter((details) => ["claim", "retire"].includes(details.args?.[0]));
    expect(ownedCalls.map((details) => details.args[0])).toEqual(["claim", "retire"]);
    for (const details of ownedCalls) {
      expect(details.target.documentIds).toEqual(["main-old"]);
      expect(await api.inject(details)).toEqual([]);
    }
    expect(replacement.win.document.querySelector("[data-vtx-ax], [data-vtx-frame-ax]")).toBeNull();
  });

  it("keeps DOM data when navigation follows a successful final check without replacing the document", async () => {
    const api = setup();
    const frame = api.frames.get(0)!;
    const doc = frame.win.document;
    const checks: Array<{ result: unknown; documentIds: string[]; documentId: string; document: Document }> = [];
    let hookCompleted = false;
    let hookError: unknown;
    api.hooks.afterInjection = (details, result) => {
      if (details.args?.[0] !== "check") return;
      try {
        checks.push({ result, documentIds: [...details.target.documentIds], documentId: frame.documentId, document: frame.win.document });
        // Isolate the navigation counter: the successful reply's identity and
        // document realm stay valid, so documentIds rejection cannot pass this test.
        api.commit();
        hookCompleted = true;
      } catch (error) {
        hookError = error;
        throw error;
      }
    };
    const pending = api.observe();
    await api.entered;
    api.release();
    const response: any = await pending;
    expect(hookError).toBeUndefined();
    expect(hookCompleted).toBe(true);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ result: true, documentIds: ["main-old"], documentId: "main-old" });
    expect(checks[0].document).toBe(doc);
    expect(api.frames.get(0)!.documentId).toBe("main-old");
    expect(api.frames.get(0)!.win.document).toBe(doc);
    expect(response.error).toBeUndefined();
    expect(response.result.elements[0].name).toBe("DOM old");
    expect(response.result.elements[0].semanticSource).not.toBe("ax");
    expect(response.result.meta?.degraded?.axOverlay).not.toBe("timeout");
  });

  it("does not reuse old child AX after a frame detaches and a new frame appears", async () => {
    const api = setup(false);
    api.makeFrame(17, "child-old", "https://child.example/old", "Old DOM", "Old AX");
    const old: any = await api.observe(true, 17);
    expect(old.error).toBeUndefined();
    // A positive control is essential: otherwise never applying child AX would pass.
    expect(old.result.elements[0].name).toBe("Old AX");
    api.frames.delete(17);
    const detached: any = await api.observe(true, 17);
    expect(detached.error?.code).toBe("IFRAME_NOT_READY");
    api.makeFrame(41, "child-new", "https://child.example/new", "New DOM", "New AX");
    const replacement: any = await api.observe(true, 41);
    expect(replacement.error).toBeUndefined();
    expect(replacement.result.elements[0].name).toBe("New AX");
    expect(replacement.result.elements[0].name).not.toBe("Old AX");
  });

  it("returns DOM data and reports AX timeout without a late overlay", async () => {
    vi.useFakeTimers();
    const { observe, entered, release } = setup();
    const pending = observe();
    await entered;
    await vi.advanceTimersByTimeAsync(6_001);
    const response: any = await pending;
    expect(response.result.meta.degraded.axOverlay).toBe("timeout");
    expect(response.result.elements[0].name).toBe("DOM old");
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(response.result.elements[0].name).toBe("DOM old");
    const next: any = await observe(false);
    expect(next.error).toBeUndefined();
    expect(next.result.elements[0].name).toBe("DOM old");
  });
});
