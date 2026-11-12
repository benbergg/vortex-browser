import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: async () => undefined }));

const windows: JSDOM["window"][] = [];

// Serialized production injections and CDP functions execute in the target
// document's MAIN realm. This models routing, not Chrome execution worlds/OOPIF.
function setup(sameOriginChild = false) {
  let revision = 0;
  const frames = new Map<number, { frameId: number; parentFrameId: number; documentId?: string; url: string; win: any }>();
  const makeFrame = (frameId: number, parentFrameId = -1) => {
    const html = `<!doctype html><body><div id="direct">Direct action</div><div id="drop">Drop files here</div><div id="host"></div>${Array.from({ length: 12 }, (_, i) => `<button id="b${i}">Native ${i}</button>`).join("")}</body>`;
    let win: any;
    if (frameId && sameOriginChild) {
      const parent = frames.get(parentFrameId)!.win;
      const iframe = parent.document.createElement("iframe");
      iframe.src = "/child";
      parent.document.body.appendChild(iframe);
      win = iframe.contentWindow;
      win.document.open();
      win.document.write(html);
      win.document.close();
    } else {
      const dom = new JSDOM(html, {
        url: frameId ? "https://child.example/same" : "https://main.example/same", pretendToBeVisual: true, runScripts: "outside-only",
      });
      windows.push(dom.window);
      win = dom.window;
    }
    win.CSS = { escape: (value: string) => value };
    win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
    Object.defineProperties(win.HTMLElement.prototype, {
      offsetWidth: { configurable: true, get: () => 80 },
      offsetHeight: { configurable: true, get: () => 30 },
    });
    win.Element.prototype.scrollIntoView = () => {};
    win.document.elementFromPoint = () => null;
    win.document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = `<div id="shadow-click">Shadow action</div><div id="shadow-drop">Shadow drop</div>`;
    const frame = { frameId, parentFrameId, documentId: `document-${frameId}-${++revision}`, url: win.location.href, win };
    frames.set(frameId, frame);
    return frame;
  };
  makeFrame(0);
  makeFrame(17, 0);
  const listeners: Array<(event: any) => void> = [];
  const injections: any[] = [];
  const writes: Array<{ frame: (typeof frames extends Map<any, infer F> ? F : never); node: any; params: any }> = [];
  const hooks: {
    holdRetire?: boolean;
    rejectClaim?: number;
    omitDocumentId?: number;
    unresolvedFrame?: number;
    beforeWrite?: (frame: any, params: any) => void;
    afterWrite?: () => void;
    afterInjection?: (details: any, frame: any, result: any) => void;
    throwCDP?: boolean;
    throwCDPOnce?: boolean;
  } = {};
  const isOwnership = (details: any) => String(details.func).includes("__vortexListenerOwner");
  const inject = async (details: any) => {
    const selected = [...frames.values()].filter((frame) => details.target.documentIds
      ? details.target.documentIds.includes(frame.documentId)
      : details.target.allFrames || (details.target.frameIds ?? [0]).includes(frame.frameId));
    const results = [];
    for (const frame of selected) {
      if (details.world !== "MAIN") throw new Error("Marker injection must use MAIN world");
      const result = await frame.win.eval(`(${String(details.func)})`)(...structuredClone(details.args ?? []));
      hooks.afterInjection?.(details, frame, result);
      results.push({ frameId: frame.frameId, documentId: frame.documentId, result });
    }
    return results;
  };
  const executeScript = vi.fn(async (details: any) => {
    injections.push(details);
    if (isOwnership(details) && details.args?.[0] === "listener.retire" && hooks.holdRetire) return [];
    if (isOwnership(details) && details.args?.[0] === "listener.claim" && details.args[1].frameId === hooks.rejectClaim) return [];
    return inject(details);
  });
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [...frames.values()].map(({ win: _win, ...frame }) => ({ ...frame, documentId: hooks.omitDocumentId === frame.frameId ? undefined : frame.documentId, documentLifecycle: "active" }))),
      onCommitted: { addListener: (listener: (event: any) => void) => listeners.push(listener) },
    },
    runtime: { getManifest: () => ({ host_permissions: ["<all_urls>"] }) },
    scripting: { executeScript },
  });
  const nodes = new Map<number, { node: any; frame: any }>();
  const backendIds = new WeakMap<object, number>();
  let nextNode = 100;
  const backendId = (node: any, frame: any) => {
    if (!backendIds.has(node)) backendIds.set(node, ++nextNode);
    const id = backendIds.get(node)!;
    nodes.set(id, { node, frame });
    return id;
  };
  const listenerNodes = () => [...frames.values()].flatMap((frame) => [
    { type: "click", backendNodeId: backendId(frame.win.document.querySelector("#direct"), frame) },
    { type: "drop", backendNodeId: backendId(frame.win.document.querySelector("#drop"), frame) },
    { type: "click", backendNodeId: backendId(frame.win.document.querySelector("#host").shadowRoot.querySelector("#shadow-click"), frame) },
    { type: "dragover", backendNodeId: backendId(frame.win.document.querySelector("#host").shadowRoot.querySelector("#shadow-drop"), frame) },
  ]);
  const runWrite = (frame: any, node: any, params: any) => frame.win.eval(`(${params.functionDeclaration})`).apply(node, structuredClone(params.arguments.map((arg: any) => arg.value)));
  const debuggerMgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(async (_tab: number, method: string, params: any) => {
      if (method === "Runtime.evaluate") return { result: { objectId: "document" } };
      if (method === "DOMDebugger.getEventListeners") {
        if (hooks.throwCDP || hooks.throwCDPOnce) {
          hooks.throwCDPOnce = false;
          throw new Error("CDP unavailable");
        }
        return { listeners: listenerNodes() };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: params.backendNodeIds };
      if (method === "DOM.resolveNode") return nodes.get(params.nodeId)?.frame.frameId === hooks.unresolvedFrame ? {} : { object: { objectId: String(params.nodeId) } };
      if (method === "Runtime.callFunctionOn") {
        const { node, frame } = nodes.get(Number(params.objectId))!;
        writes.push({ node, frame, params });
        hooks.beforeWrite?.(frame, params);
        try {
          return { result: { value: runWrite(frame, node, params) } };
        } finally { hooks.afterWrite?.(); }
      }
      return {};
    }),
  };
  const router = new ActionRouter();
  registerObserveHandlers(router, debuggerMgr as any);
  const observe = (args: Record<string, unknown> = {}) => router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: args.cursor ? args : { frames: "main", includeAX: false, detail: "full", ...args }, requestId: "listener-ownership", tabId: 42 });
  const ownership = (action: string) => injections.filter((details) => isOwnership(details) && details.args?.[0] === `listener.${action}`);
  const navigate = (frameId: number) => {
    const old = frames.get(frameId)!;
    makeFrame(frameId, old.parentFrameId);
    if (frameId === 0) makeFrame(17, 0);
    for (const listener of listeners) listener({ tabId: 42, frameId, documentId: frames.get(frameId)!.documentId, url: old.url });
    return old;
  };
  return { frames, hooks, observe, inject, injections, ownership, writes, runWrite, navigate };
}

afterEach(() => {
  for (const win of windows.splice(0)) win.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const markerNodes = (frame: any) => [frame.win.document.querySelector("#direct"), frame.win.document.querySelector("#drop"), ...frame.win.document.querySelector("#host").shadowRoot.querySelectorAll("div")];

describe("listener/dropzone document request ownership", () => {
  it("does not report an untargeted same-origin child as incomplete during main-frame discovery", async () => {
    const api = setup(true);
    expect(api.frames.get(17)!.win.top).toBe(api.frames.get(0)!.win);
    const response: any = await api.observe();
    expect(response.error).toBeUndefined();
    expect(response.result.elements.some((element: any) => element.listenerInteractive)).toBe(true);
    expect(api.ownership("claim").map((details) => details.target.documentIds[0])).toEqual([api.frames.get(0)!.documentId]);
    expect(markerNodes(api.frames.get(17)).every((node) => !node.hasAttribute("data-vtx-listener") && !node.hasAttribute("data-vtx-dropzone"))).toBe(true);
    expect(response.result.meta.degraded?.listenerDiscovery).toBeUndefined();
  });

  it("does not retain a non-target child error after successful same-origin auto-fallback", async () => {
    const api = setup(true);
    for (const node of api.frames.get(0)!.win.document.querySelectorAll("button")) node.remove();
    const response: any = await api.observe({ frames: undefined });
    expect(response.error).toBeUndefined();
    expect(response.result.meta.autoFallback).toBe(true);
    expect(response.result.elements.some((element: any) => element.frameId === 17 && element.listenerInteractive)).toBe(true);
    expect(response.result.elements.some((element: any) => element.frameId === 17 && element.dropzoneInteractive)).toBe(true);
    expect(api.ownership("claim").map((details) => details.target.documentIds[0])).toEqual([...api.frames.values()].map((frame) => frame.documentId));
    expect(response.result.meta.degraded?.listenerDiscovery).toBeUndefined();
  });

  it("retains a genuine main-frame failure when later same-origin fallback discovery succeeds", async () => {
    const api = setup(true);
    for (const node of api.frames.get(0)!.win.document.querySelectorAll("button")) node.remove();
    api.hooks.throwCDPOnce = true;
    const response: any = await api.observe({ frames: undefined });
    expect(response.error).toBeUndefined();
    expect(response.result.meta.autoFallback).toBe(true);
    expect(response.result.elements.some((element: any) => element.frameId === 17 && element.listenerInteractive)).toBe(true);
    expect(response.result.meta.degraded?.listenerDiscovery).toBe("error");
  });

  it("reports an incomplete target instead of ignoring its missing owner", async () => {
    const api = setup(true);
    api.hooks.beforeWrite = (frame) => {
      if (frame.frameId === 0) delete frame.win.document.__vortexListenerOwner;
    };
    const response: any = await api.observe();
    expect(response.error).toBeUndefined();
    expect(response.result.meta.degraded?.listenerDiscovery).toBe("error");
    expect(response.result.elements.some((element: any) => element.listenerInteractive || element.dropzoneInteractive)).toBe(false);
  });

  it("claims documentIds, stamps request tokens in light/shadow DOM and retires without invalidating pagination", async () => {
    const api = setup();
    const stamped: string[] = [];
    const discovered: any[] = [];
    api.hooks.afterInjection = (details, frame, result) => {
      if (String(details.func).includes("const scanRoot")) {
        discovered.push(...result.elements);
        stamped.push(...markerNodes(frame).map((node) => node.getAttribute(node.id.includes("drop") ? "data-vtx-dropzone" : "data-vtx-listener")));
      }
    };
    const response: any = await api.observe({ paginate: true, maxElements: 2 });
    expect(response.error).toBeUndefined();
    const claim = api.ownership("claim")[0];
    expect(claim).toBeDefined();
    expect(claim.target).toEqual({ tabId: 42, documentIds: [api.frames.get(0)!.documentId] });
    expect(stamped).toEqual(Array(4).fill(claim.args[1].token));
    expect(discovered.filter((element) => element.listenerInteractive)).toHaveLength(2);
    expect(discovered.filter((element) => element.dropzoneInteractive)).toHaveLength(2);
    const doc = api.frames.get(0)!.win.document;
    expect(markerNodes(api.frames.get(0)).every((node) => !node.hasAttribute("data-vtx-listener") && !node.hasAttribute("data-vtx-dropzone"))).toBe(true);
    expect(doc.__vortexListenerOwner.owner).toBeNull();
    const state = api.frames.get(0)!.win.__vortexPageSnapshots[response.result.snapshotId];
    expect(state.check()).toBe(true);
    const next: any = await api.observe({ cursor: response.result.nextCursor });
    expect(next.error).toBeUndefined();
    doc.querySelector("#direct").textContent = "Real mutation";
    expect(state.check()).toBe(false);
  });

  it("rejects late old writes, claims, cleanup and reads while a newer request owns the same document", async () => {
    const api = setup();
    api.hooks.holdRetire = true; // Explicitly omit delivery; replay the real function below.
    const a: any = await api.observe();
    expect(a.error).toBeUndefined();
    const claimA = api.ownership("claim")[0];
    expect(claimA).toBeDefined();
    const writeA = api.writes.find((write) => write.frame.frameId === 0)!;
    const scanA = api.injections.find((details) => String(details.func).includes("const scanRoot"));
    const b: any = await api.observe();
    expect(b.error).toBeUndefined();
    const claimB = api.ownership("claim")[1];
    const frame = api.frames.get(0)!;
    expect(markerNodes(frame).map((node) => node.getAttribute(node.id.includes("drop") ? "data-vtx-dropzone" : "data-vtx-listener"))).toEqual(Array(4).fill(claimB.args[1].token));
    expect(api.runWrite(writeA.frame, writeA.node, writeA.params)).toBe(false);
    expect((await api.inject(claimA))[0].result).toBe(false);
    await api.inject(api.ownership("retire")[0]);
    expect(frame.win.document.__vortexListenerOwner.owner).toBe(claimB.args[1].token);
    frame.win.document.querySelector("#b0").setAttribute("data-vtx-listener", claimB.args[1].token);
    frame.win.document.querySelector("#b0").setAttribute("data-vtx-dropzone", claimB.args[1].token);
    const replay = (await api.inject(scanA))[0].result;
    expect(replay).toBeNull();
    expect(markerNodes(frame).every((node) => node.getAttribute(node.id.includes("drop") ? "data-vtx-dropzone" : "data-vtx-listener") === claimB.args[1].token)).toBe(true);
  });

  it("keeps a retire-before-claim tombstone, high water and epoch isolation", async () => {
    const api = setup();
    await api.observe();
    const claim = api.ownership("claim")[0];
    expect(claim).toBeDefined();
    const request = { ...claim.args[1], order: claim.args[1].order + 10, token: "retired-before-claim" };
    const retire = { ...api.ownership("retire")[0], args: ["listener.retire", request] };
    // The logical tombstone is retained, but physical cleanup has no live scan lease.
    expect((await api.inject(retire))[0].result).toBe(false);
    expect(api.frames.get(0)!.win.document.__vortexListenerOwner.retired).toBe(true);
    expect((await api.inject({ ...claim, args: ["listener.claim", request] }))[0].result).toBe(false);
    const newer = { ...request, order: request.order + 1, token: "newer" };
    expect((await api.inject({ ...claim, args: ["listener.claim", newer] }))[0].result).toBe(true);
    expect((await api.inject({ ...claim, args: ["listener.claim", { ...request, deadline: Date.now() + 60_000 }] }))[0].result).toBe(false);
    expect((await api.inject({ ...claim, args: ["listener.claim", { ...newer, epoch: "other-worker", order: newer.order + 1 }] }))[0].result).toBe(false);
    await api.inject({ ...retire, args: ["listener.retire", { ...newer, epoch: "other-worker" }] });
    expect(api.frames.get(0)!.win.document.__vortexListenerOwner.owner).toBe("newer");
  });

  it("does not let old documentIds or old CDP writes touch a same-URL reload or a parent's replacement child", async () => {
    const api = setup();
    api.hooks.holdRetire = true;
    await api.observe({ frames: "all-permitted" });
    expect(api.ownership("claim")).toHaveLength(2);
    const oldClaims = [...api.ownership("claim")];
    const oldRetires = [...api.ownership("retire")];
    const oldWrites = [...api.writes];
    api.navigate(17);
    for (const details of [...oldClaims, ...oldRetires].filter((details) => details.args[1].frameId === 17)) expect(await api.inject(details)).toEqual([]);
    api.navigate(0);
    const response: any = await api.observe({ frames: "all-permitted" });
    expect(response.error).toBeUndefined();
    for (const details of [...oldClaims, ...oldRetires]) expect(await api.inject(details)).toEqual([]);
    for (const oldWrite of oldWrites) {
      const frame = api.frames.get(oldWrite.frame.frameId)!;
      const node = oldWrite.node.id.startsWith("shadow-") ? frame.win.document.querySelector("#host").shadowRoot.querySelector(`#${oldWrite.node.id}`) : frame.win.document.querySelector(`#${oldWrite.node.id}`);
      const before = node.outerHTML;
      expect(api.runWrite(frame, node, oldWrite.params)).toBe(false);
      expect(node.outerHTML).toBe(before);
    }
  });

  it("fails closed for missing IDs and partial claims while retiring confirmed light/shadow markers", async () => {
    const api = setup();
    api.hooks.omitDocumentId = 17;
    const missing: any = await api.observe({ frames: "all-permitted" });
    expect(missing.error).toBeUndefined();
    expect(missing.result.elements.filter((element: any) => element.frameId === 17).every((element: any) => !element.listenerInteractive && !element.dropzoneInteractive)).toBe(true);
    expect(markerNodes(api.frames.get(17)).every((node) => !node.hasAttribute("data-vtx-listener") && !node.hasAttribute("data-vtx-dropzone"))).toBe(true);
    expect(api.ownership("claim")).toHaveLength(1);
    api.navigate(17);
    api.hooks.omitDocumentId = undefined;
    api.hooks.rejectClaim = 17;
    const partial: any = await api.observe({ frames: "all-permitted" });
    expect(partial.error).toBeUndefined();
    expect(partial.result.elements.some((element: any) => element.frameId === 0 && element.listenerInteractive)).toBe(true);
    expect(partial.result.elements.filter((element: any) => element.frameId === 17).every((element: any) => !element.listenerInteractive && !element.dropzoneInteractive)).toBe(true);
    expect(api.frames.get(0)!.win.document.__vortexListenerOwner.owner).toBeNull();
    const lateClaim = api.ownership("claim").findLast((details) => details.args[1].frameId === 17);
    expect((await api.inject(lateClaim))[0].result).toBe(false);
    expect(api.frames.get(17)!.win.document.__vortexListenerOwner.retired).toBe(true);
  });

  it("checks expiry inside the actual CDP write and retires after discovery failure", async () => {
    const api = setup();
    let expiredWrites = 0;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    api.hooks.beforeWrite = (frame) => {
      if (!frame.win.document.__vortexListenerOwner) return;
      expiredWrites++;
      clock = vi.spyOn(frame.win.Date, "now").mockReturnValue(frame.win.document.__vortexListenerOwner.deadline);
    };
    api.hooks.afterWrite = () => clock?.mockRestore();
    const expired: any = await api.observe();
    expect(expired.error).toBeUndefined();
    expect(expired.result.meta.degraded.listenerDiscovery).toBe("error");
    expect(markerNodes(api.frames.get(0)).every((node) => !node.hasAttribute("data-vtx-listener") && !node.hasAttribute("data-vtx-dropzone"))).toBe(true);
    expect(expiredWrites).toBeGreaterThan(0);
    api.hooks.beforeWrite = undefined;
    api.hooks.afterWrite = undefined;
    api.hooks.throwCDP = true;
    const rejected: any = await api.observe();
    expect(rejected.error).toBeUndefined();
    expect(rejected.result.meta.degraded.listenerDiscovery).toBe("error");
    expect(api.frames.get(0)!.win.document.__vortexListenerOwner.owner).toBeNull();
  });

  it("retires every claimed document through finally when the overall deadline expires", async () => {
    const api = setup();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    api.hooks.afterWrite = () => {
      if (!clock) clock = vi.spyOn(Date, "now").mockReturnValue(api.ownership("claim")[0].args[1].deadline);
    };
    try {
      const response: any = await api.observe({ frames: "all-permitted" });
      expect(response.error?.code).toBe("TIMEOUT");
      expect(api.ownership("retire")).toHaveLength(2);
      for (const frame of api.frames.values()) {
        expect(frame.win.document.__vortexListenerOwner.owner).toBeNull();
        expect(markerNodes(frame).every((node) => !node.hasAttribute("data-vtx-listener") && !node.hasAttribute("data-vtx-dropzone"))).toBe(true);
      }
    } finally { clock?.mockRestore(); }
  });

  it("fails closed without enumeration identity and keeps late cleanup from mutating DOM", async () => {
    const api = setup();
    api.hooks.holdRetire = true;
    const a: any = await api.observe({ paginate: true, maxElements: 2 });
    const retireA = api.ownership("retire")[0];
    expect(retireA).toBeDefined();
    api.hooks.omitDocumentId = 0;
    const b: any = await api.observe({ paginate: true, maxElements: 2 });
    expect(b.error?.code).toBe("STALE_SNAPSHOT");
    expect(b.result).toBeUndefined();
    const frame = api.frames.get(0)!;
    expect(a.error).toBeUndefined();
    expect(Object.keys(frame.win.__vortexPageSnapshots)).toEqual([]);
    const before = markerNodes(frame).map((node) => node.outerHTML);
    await api.inject(retireA);
    expect(markerNodes(frame).map((node) => node.outerHTML)).toEqual(before);
    expect(Object.keys(frame.win.__vortexPageSnapshots)).toEqual([]);
  });

  it("claims auto-fallback children before discovering their listener/dropzone markers", async () => {
    const api = setup();
    for (const node of api.frames.get(0)!.win.document.querySelectorAll("button")) node.remove();
    const response: any = await api.observe({ frames: undefined });
    expect(response.error).toBeUndefined();
    expect(response.result.meta.autoFallback).toBe(true);
    expect(response.result.elements.some((element: any) => element.frameId === 17 && element.listenerInteractive)).toBe(true);
    expect(response.result.elements.some((element: any) => element.frameId === 17 && element.dropzoneInteractive)).toBe(true);
    expect(api.ownership("claim").map((details) => details.target.documentIds[0])).toEqual([...api.frames.values()].map((frame) => frame.documentId));
  });

  it("safely degrades a claimed child whose CDP nodes cannot be resolved", async () => {
    const api = setup();
    api.hooks.unresolvedFrame = 17;
    const response: any = await api.observe({ frames: "all-permitted" });
    expect(response.error).toBeUndefined();
    expect(response.result.meta.degraded.listenerDiscovery).toBe("error");
    expect(response.result.elements.some((element: any) => element.frameId === 0 && element.listenerInteractive)).toBe(true);
    expect(response.result.elements.filter((element: any) => element.frameId === 17).every((element: any) => !element.listenerInteractive && !element.dropzoneInteractive)).toBe(true);
    expect(api.frames.get(17)!.win.document.__vortexListenerOwner.owner).toBeNull();
  });

  it("late cleanup leaves a newer pagination monitor and token markers untouched", async () => {
    const api = setup();
    api.hooks.holdRetire = true;
    await api.observe();
    const retireA = api.ownership("retire")[0];
    expect(retireA).toBeDefined();
    const b: any = await api.observe({ paginate: true, maxElements: 2 });
    expect(b.error).toBeUndefined();
    const frame = api.frames.get(0)!;
    const monitor = frame.win.__vortexPageSnapshots[b.result.snapshotId];
    expect(monitor.check()).toBe(true);
    const before = markerNodes(frame).map((node) => node.outerHTML);
    await api.inject(retireA);
    expect(markerNodes(frame).map((node) => node.outerHTML)).toEqual(before);
    expect(monitor.check()).toBe(true);
    const next: any = await api.observe({ cursor: b.result.nextCursor });
    expect(next.error).toBeUndefined();
  });
});
