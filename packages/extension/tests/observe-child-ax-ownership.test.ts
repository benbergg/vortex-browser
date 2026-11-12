import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { updateScanOwnership } from "../src/handlers/observe-scan-ownership.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/handlers/observe-js-listener.js", () => ({ markListenerElements: vi.fn().mockResolvedValue({ mechanism: "domDebugger" }) }));

const windows: JSDOM["window"][] = [];

// This executes the serialized production injections in separate document realms.
// CDP visibility is modeled separately: an OOPIF has no contentDocument here and
// cannot be resolved through the top target. This is not a real Chrome process test.
function setup(oopif = false) {
  let version = 0;
  const frames = new Map<number, { frameId: number; parentFrameId: number; documentId: string; url: string; win: any }>();
  const makeFrame = (frameId: number, parentFrameId: number, url: string) => {
    const dom = new JSDOM(`<!doctype html><body>${Array.from({ length: 14 }, (_, i) => `<button id="b${i}">DOM ${frameId} ${i}</button>`).join("")}<div id="host"></div></body>`, { url, pretendToBeVisual: true, runScripts: "outside-only" });
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
  makeFrame(41, 0, "https://child.example/same");
  const listeners: Array<(event: any) => void> = [];
  const historyListeners: Array<(event: any) => void> = [];
  const hooks: {
    beforeInjection?: (details: any) => Promise<void> | void;
    ownership?: (details: any) => boolean;
    afterInjection?: (details: any, frameId: number, result: unknown) => void;
    ax?: (frameId: number) => Promise<void>;
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
    const selected = [...frames.values()].filter((f) => target.documentIds ? target.documentIds.includes(f.documentId) : target.allFrames || (target.frameIds ?? [0]).includes(f.frameId));
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
      onHistoryStateUpdated: { addListener: (listener: (event: any) => void) => historyListeners.push(listener) },
    },
    runtime: { getManifest: () => ({ host_permissions: ["<all_urls>"] }) },
    scripting: { executeScript: vi.fn(async (details: any) => {
      await hooks.beforeInjection?.(details);
      return hooks.ownership?.(details) ? [] : inject(details);
    }) },
  });
  const backendIds = new WeakMap<object, number>();
  let nextBackend = 100;
  const backendId = (node: object) => {
    if (!backendIds.has(node)) backendIds.set(node, ++nextBackend);
    return backendIds.get(node)!;
  };
  const project = (node: any): any => ({
    nodeName: node.nodeName,
    backendNodeId: backendId(node),
    attributes: node.attributes ? Array.from(node.attributes).flatMap((a: any) => [a.name, a.value]) : [],
    children: Array.from(node.children ?? []).map(project),
    ...(node.shadowRoot ? { shadowRoots: [project(node.shadowRoot)] } : {}),
  });
  const cdpDocument = (id: number): any => {
    const frame = frames.get(id)!;
    const root = project(frame.win.document);
    root.children.push(...[...frames.values()].filter((f) => f.parentFrameId === id).map((f) => ({
      nodeName: "IFRAME", frameId: `CDP-${f.frameId}`,
      ...(!oopif || f.frameId !== 17 ? { contentDocument: cdpDocument(f.frameId) } : {}),
    })));
    return root;
  };
  const debuggerMgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(async (_tab: number, method: string, params?: any) => {
      if (method === "DOM.getDocument") return { root: cdpDocument(0) };
      if (method === "Accessibility.getFullAXTree") {
        const id = Number(params?.frameId?.slice(4) ?? 0);
        const frame = frames.get(id)!;
        const nodes = [frame.win.document, frame.win.document.querySelector("#host").shadowRoot].flatMap((root) => Array.from(root.querySelectorAll("[data-vtx-ax]"))).map((el: any) => ({
          nodeId: String(backendId(el)), backendDOMNodeId: backendId(el), role: { value: "button" }, name: { value: `AX ${id} ${el.id}` },
        }));
        await hooks.ax?.(id);
        return { nodes };
      }
      return {};
    }),
  };
  const router = new ActionRouter();
  registerObserveHandlers(router, debuggerMgr as any);
  const observe = (args: Record<string, unknown> = {}) => router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: args.cursor ? args : { frameId: 17, includeAX: true, ...args }, requestId: "child-ownership", tabId: 42 });
  const history = (frameId: number) => {
    const frame = frames.get(frameId)!;
    frame.win.history.pushState({}, "", "#same-document");
    historyListeners.forEach((listener) => listener({ tabId: 42, frameId, documentId: frame.documentId, url: frame.win.location.href }));
  };
  const commit = (frameId: number, documentId?: string) => listeners.forEach((listener) => listener({ tabId: 42, frameId, documentId }));
  return { frames, hooks, navigate, history, commit, inject, debuggerMgr, observe, execute: vi.mocked(chrome.scripting.executeScript) };
}

afterEach(() => {
  for (const win of windows.splice(0)) win.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("scan publication boundaries", () => {
  it.each([17, 9, 0])("rejects non-paginated refs when frame %i commits after a successful final check", async (frameId) => {
    const api = setup();
    const old = api.frames.get(17)!;
    let checked = false;
    api.hooks.afterInjection = (details, id) => {
      if (details.args?.[0] === "scan.check" && id === 17 && !checked) {
        checked = true;
        api.navigate(frameId);
      }
    };
    const response: any = await api.observe({ frameId: undefined, frames: [17, 41], includeAX: false });
    expect(checked).toBe(true);
    expect(api.frames.get(17)!.win.document).not.toBe(old.win.document);
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.result).toBeUndefined();
  });

  it("preserves non-paginated DOM refs for same-document history after the final check", async () => {
    const api = setup();
    const old = api.frames.get(17)!;
    let checked = false;
    api.hooks.afterInjection = (details, id) => {
      if (details.args?.[0] === "scan.check" && id === 17 && !checked) {
        checked = true;
        api.history(17);
      }
    };
    const response: any = await api.observe({ includeAX: false });
    expect(checked).toBe(true);
    expect(api.frames.get(17)).toBe(old);
    expect(response.error).toBeUndefined();
    expect(response.result.elements[0].name).toBe("DOM 17 0");
  });

  it.each(["before", "after"])("revalidates an identity-less commit %s the final document check", async (timing) => {
    const api = setup();
    const doc = api.frames.get(17)!.win.document;
    let committed = false;
    api.hooks.afterInjection = (details, id) => {
      const atBoundary = timing === "before" ? String(details.func).includes("const scanRoot") : details.args?.[0] === "scan.check";
      if (atBoundary && id === 17 && !committed) {
        committed = true;
        api.commit(17);
      }
    };
    const response: any = await api.observe({ includeAX: false });
    expect(committed).toBe(true);
    expect(api.frames.get(17)!.win.document).toBe(doc);
    if (timing === "before") {
      expect(response.error).toBeUndefined();
      expect(response.result.elements[0].name).toBe("DOM 17 0");
    } else {
      expect(response.error?.code).toBe("STALE_SNAPSHOT");
      expect(response.result).toBeUndefined();
    }
  });

  it("does not forgive an identity-less commit that actually replaces the document", async () => {
    const api = setup();
    let replaced = false;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] === "scan.check" && !replaced) {
        replaced = true;
        api.navigate(17);
        api.commit(17);
      }
    };
    const response: any = await api.observe({ includeAX: false });
    expect(replaced).toBe(true);
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.result).toBeUndefined();
  });

  it.each([false, true])("keeps a known replacement invalid after identity-less commits (restored document: %s)", async (restoreCommit) => {
    const api = setup();
    const old = api.frames.get(17)!;
    let replaced = false;
    let checkResult: unknown;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] === "scan.check" && !replaced) {
        replaced = true;
        api.navigate(17);
        // Restore the retained realm as with back/forward cache, so the real
        // documentIds/token check succeeds and cannot mask lost commit history.
        api.frames.set(17, old);
        if (restoreCommit) api.commit(17, old.documentId);
        api.commit(17);
      }
    };
    api.hooks.afterInjection = (details, _id, result) => {
      if (details.args?.[0] === "scan.check") checkResult = result;
    };
    const response: any = await api.observe({ includeAX: false });
    expect(replaced).toBe(true);
    expect(checkResult).toBe(true);
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.result).toBeUndefined();
  });

  it.each(["history", "roundtrip"])("handles a mismatched entry identity with %s after the real final check", async (navigation) => {
    const api = setup();
    const a = api.frames.get(17)!;
    api.navigate(17);
    const b = api.frames.get(17)!;
    api.frames.set(17, a);
    api.commit(17);
    let checked: unknown;
    api.hooks.afterInjection = (details, id, result) => {
      if (details.args?.[0] === "scan.check" && id === 17) {
        checked = result;
        if (navigation === "history") api.history(17);
        else {
          api.frames.set(17, b);
          api.commit(17, b.documentId);
          api.frames.set(17, a);
          api.commit(17, a.documentId);
        }
      }
    };
    const response: any = await api.observe({ includeAX: false });
    expect(checked).toBe(true);
    expect(api.frames.get(17)!.win.document).toBe(a.win.document);
    if (navigation === "history") {
      expect(response.error).toBeUndefined();
      expect(response.result.elements[0].name).toBe("DOM 17 0");
    } else {
      expect(response.error?.code).toBe("STALE_SNAPSHOT");
      expect(response.result).toBeUndefined();
    }
  });

  it.each(["ownership.probe", "ownership.handover"])("bounds retired-epoch recovery at the shared claim deadline with stalled %s", async (heldAction) => {
    vi.useFakeTimers();
    const api = setup();
    const started = Date.now();
    const frame = api.frames.get(17)!;
    const old = { frameId: 17, documentId: frame.documentId, epoch: "retired-old-epoch", order: 1, token: "old-scan", deadline: started + 60_000 };
    const target = { tabId: 42, documentIds: [frame.documentId] };
    for (const action of ["scan.claim", "scan.retire"]) {
      expect(await api.inject({ target, func: updateScanOwnership, args: [action, old] })).toMatchObject([{ result: true }]);
    }
    expect(frame.win.document.__vortexScanOwner).toMatchObject({ epoch: old.epoch, retired: true, owner: null });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    let rejectedAt: number | undefined;
    let rejection: unknown;
    let firstRecoveryAt: number | undefined;
    let probe: any;
    let nextStarted = false;
    api.hooks.beforeInjection = async (details) => {
      const action = details.args?.[0];
      if (action === "scan.claim" && details.args[1].frameId === 17) {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      if (action === heldAction && details.args[1] === "scan" && details.args[2].frameId === 17) {
        firstRecoveryAt ??= Date.now();
        events.push("pending");
        await held;
      }
      if (nextStarted && action === "scan.claim" && details.args[1].frameId === 41) events.push("next-claim");
    };
    api.hooks.afterInjection = (details, id, result) => {
      if (details.args?.[0] === "scan.claim" && id === 17) {
        rejection = result;
        rejectedAt = Date.now();
      }
      if (details.args?.[0] === "ownership.probe" && id === 17) probe = result;
      if (details.args?.[0] === heldAction && details.args[1] === "scan" && id === 17) events.push("settled");
    };
    let response: any;
    const pending = api.observe({ frameId: undefined, frames: [17, 41], includeAX: false }).then((value) => { response = value; });
    await vi.advanceTimersByTimeAsync(999);
    const beforeDeadline = response;
    await vi.advanceTimersByTimeAsync(2);
    const withinBudget = response;
    const hadPendingRecovery = events.includes("pending");
    nextStarted = true;
    let nextFinished = false;
    const next = api.observe({ frameId: 41, includeAX: false }).then((value) => { nextFinished = true; return value; });
    await vi.advanceTimersByTimeAsync(1);
    const gated = !nextFinished && !events.includes("next-claim");
    release();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    const nextResponse: any = await next;
    expect(rejection).toBe(false);
    expect(rejectedAt).toBe(started + 900);
    expect(firstRecoveryAt).toBe(started + 900);
    expect(probe).toMatchObject({ epoch: old.epoch, retired: true, owner: null });
    expect(beforeDeadline).toBeUndefined();
    expect(withinBudget).toBeDefined();
    expect(withinBudget.error).toBeUndefined();
    expect(withinBudget.result.elements[0].name).toBe("DOM 41 0");
    expect(withinBudget.result.meta.degraded.unclaimedFrames).toContain(17);
    expect(hadPendingRecovery).toBe(true);
    expect(gated).toBe(true);
    expect(events.lastIndexOf("settled")).toBeLessThan(events.indexOf("next-claim"));
    expect(nextResponse.error).toBeUndefined();
  });

  it("bounds a stalled child claim without spending healthy scanning time or releasing the gate", async () => {
    vi.useFakeTimers();
    const api = setup();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let firstClaim: any;
    api.hooks.beforeInjection = async (details) => {
      if (details.args?.[0] === "scan.claim" && details.args[1].frameId === 17 && !firstClaim) {
        firstClaim = details;
        entered();
        await held;
      }
    };
    let response: any;
    const pending = api.observe({ frameId: undefined, frames: [17, 41], includeAX: false }).then((value) => { response = value; });
    await waiting;
    await vi.advanceTimersByTimeAsync(1_500);
    const withinBudget = response;
    const scanned = api.execute.mock.calls.some(([details]: any) => String(details.func).includes("const scanRoot") && details.target.documentIds?.[0] === api.frames.get(41)!.documentId);
    const claimCount = () => api.execute.mock.calls.filter(([details]: any) => details.args?.[0] === "scan.claim").length;
    const beforeNext = claimCount();
    let nextFinished = false;
    const next = api.observe({ frameId: 41, includeAX: false }).then((value) => { nextFinished = true; return value; });
    await vi.advanceTimersByTimeAsync(1);
    const gated = !nextFinished && claimCount() === beforeNext;
    release();
    await pending;
    const nextResponse: any = await next;
    expect(withinBudget).toBeDefined();
    expect(withinBudget.error).toBeUndefined();
    expect(withinBudget.result.elements.some((element: any) => element.frameId === 41)).toBe(true);
    expect(withinBudget.result.meta.degraded.unclaimedFrames).toContain(17);
    expect(scanned).toBe(true);
    expect(gated).toBe(true);
    expect(nextResponse.error).toBeUndefined();
    // The tracked, late real claim must meet its retirement tombstone.
    expect(await api.inject(firstClaim)).toMatchObject([{ frameId: 17, result: false }]);
  });

  it("still validates an empty successful page that contributes frame metadata", async () => {
    const api = setup();
    api.frames.get(17)!.win.document.body.innerHTML = "";
    let checked = false;
    api.hooks.beforeInjection = (details) => {
      if (details.args?.[0] === "scan.check" && details.args[1].frameId === 17 && !checked) {
        checked = true;
        api.navigate(17);
      }
    };
    const response: any = await api.observe({ frameId: undefined, frames: [17, 41], includeAX: false });
    expect(checked).toBe(true);
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.result).toBeUndefined();
  });

  it("ignores a document lost before its scan when it contributes no page data", async () => {
    const api = setup();
    const lostDocument = api.frames.get(17)!.documentId;
    let lost = false;
    api.hooks.beforeInjection = (details) => {
      if (!lost && String(details.func).includes("const scanRoot") && details.target.documentIds?.[0] === lostDocument) {
        lost = true;
        api.navigate(17);
      }
    };
    const response: any = await api.observe({ frameId: undefined, frames: [17, 41], includeAX: false });
    expect(lost).toBe(true);
    expect(response.error).toBeUndefined();
    expect(response.result.elements.every((element: any) => element.frameId === 41)).toBe(true);
    expect(response.result.elements[0].name).toBe("DOM 41 0");
    expect(response.result.frames.find((frame: any) => frame.frameId === 17).scanned).toBe(false);
    const checks = api.execute.mock.calls.filter(([details]: any) => details.args?.[0] === "scan.check");
    expect(checks.map(([details]: any) => details.target.documentIds)).toEqual([[api.frames.get(41)!.documentId]]);
  });
});

describe("child AX document ownership", () => {
  it("routes real claim, token stamping, AX capture and retirement for same-URL cross-origin siblings", async () => {
    const api = setup();
    api.hooks.afterInjection = (details, id) => {
      if (String(details.func).includes("const scanRoot")) {
        const request = details.args.at(-1);
        expect(request.documentId).toBe(api.frames.get(id)!.documentId);
        expect(api.frames.get(id)!.win.document.documentElement.getAttribute("data-vtx-frame-ax")).toBe(request.token);
        expect(api.frames.get(id)!.win.document.querySelector("#b0").getAttribute("data-vtx-ax")).toBe(`${request.token}:0`);
      }
    };
    const response: any = await api.observe({ frameId: undefined, frames: [17, 41] });
    expect(response.error).toBeUndefined();
    for (const id of [17, 41]) {
      expect(response.result.elements.filter((el: any) => el.frameId === id).every((el: any) => el.name.startsWith(`AX ${id} `))).toBe(true);
      expect(api.debuggerMgr.sendCommand).toHaveBeenCalledWith(42, "Accessibility.getFullAXTree", { frameId: `CDP-${id}` });
      const doc = api.frames.get(id)!.win.document;
      expect(doc.querySelector("[data-vtx-ax], [data-vtx-frame-ax]")).toBeNull();
      expect(doc.querySelector("#host").shadowRoot.querySelector("[data-vtx-ax]")).toBeNull();
      expect(doc.__vortexAXOwner.owner).toBeNull();
      expect(api.execute.mock.calls.some(([details]: any) => details.args?.[0] === "claim" && details.target.documentIds?.[0] === api.frames.get(id)!.documentId)).toBe(true);
    }
  });

  it("degrades an unresolvable OOPIF without guessing a URL or using a Chrome frameId as a CDP id", async () => {
    const api = setup(true);
    const response: any = await api.observe({ frameId: undefined, frames: [17, 41] });
    expect(response.error).toBeUndefined();
    expect(response.result.frames.find((f: any) => f.frameId === 17).axStatus).toBe("unavailable");
    expect(response.result.elements.find((el: any) => el.frameId === 17).name).toBe("DOM 17 0");
    expect(response.result.elements.find((el: any) => el.frameId === 41).name).toBe("AX 41 b0");
    expect(api.debuggerMgr.sendCommand.mock.calls.filter((call) => call[1] === "Accessibility.getFullAXTree").map((call) => call[2])).toEqual([{ frameId: "CDP-41" }]);
  });

  it("rejects delayed old claims, early retire and scan replay using document-owned high-water tombstones", async () => {
    const api = setup();
    api.hooks.ownership = (details) => ["claim", "retire"].includes(details.args?.[0]);
    await api.observe();
    await api.observe();
    const calls = api.execute.mock.calls.map(([details]: any) => details);
    const [a, b] = calls.filter((details) => details.args?.[0] === "claim");
    const [retireA, retireB] = calls.filter((details) => details.args?.[0] === "retire");
    expect((await api.inject(b))[0].result).toBe(true);
    expect((await api.inject(a))[0].result).toBe(false);
    await api.inject(retireA);
    const scan = calls.find((details) => String(details.func).includes("const scanRoot"));
    const scanAs = (request: any) => api.inject({ ...scan, args: [...scan.args.slice(0, -1), request] });
    expect((await scanAs(a.args[1]))[0].result).toBeNull();
    const { updateScanOwnership } = await import("../src/handlers/observe-scan-ownership.js");
    const lease = { ...scan.args[9], order: scan.args[9].order + 10, token: "current-child-scan" };
    expect((await api.inject({ ...scan, func: updateScanOwnership, args: ["scan.claim", lease] }))[0].result).toBe(true);
    scan.args[9] = lease;
    const current = { ...b.args[1], scanToken: lease.token };
    expect((await scanAs(current))[0].result.axStamped).toBe(true);
    const doc = api.frames.get(17)!.win.document;
    expect(doc.querySelector("#b0").getAttribute("data-vtx-ax")).toBe(`${b.args[1].token}:0`);
    await api.inject(retireA);
    expect(doc.querySelector("#b0").getAttribute("data-vtx-ax")).toBe(`${b.args[1].token}:0`);
    await api.inject({ ...retireB, args: ["retire", current] });
    expect((await api.inject(b))[0].result).toBe(false);
    expect((await scanAs(current))[0].result).toBeNull();
    expect(doc.querySelector("[data-vtx-ax]")).toBeNull();
  });

  it("retire arriving before its first claim prevents both the claim and actual stamping", async () => {
    const api = setup();
    api.hooks.ownership = (details) => ["claim", "retire"].includes(details.args?.[0]);
    await api.observe();
    const calls = api.execute.mock.calls.map(([details]: any) => details);
    const claim = calls.find((details) => details.args?.[0] === "claim");
    await api.inject(calls.find((details) => details.args?.[0] === "retire"));
    expect((await api.inject(claim))[0].result).toBe(false);
    const scan = calls.find((details) => String(details.func).includes("const scanRoot"));
    const { updateScanOwnership } = await import("../src/handlers/observe-scan-ownership.js");
    const lease = { ...scan.args[9], order: scan.args[9].order + 1, token: "retired-ax-current-scan" };
    expect((await api.inject({ ...scan, func: updateScanOwnership, args: ["scan.claim", lease] }))[0].result).toBe(true);
    const args = [...scan.args]; args[9] = lease;
    expect((await api.inject({ ...scan, args }))[0].result.axStamped).toBe(false);
  });

  it.each([17, 9, 0])("rejects old AX when frame %i navigates at the final document check, including same-URL ancestor reload", async (frameId) => {
    const api = setup();
    let navigated = false;
    api.hooks.afterInjection = (details) => {
      if (details.args?.[0] === "check" && !navigated) { navigated = true; api.navigate(frameId); }
    };
    const response: any = await api.observe();
    expect(navigated).toBe(true);
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.result).toBeUndefined();
    expect(api.frames.get(17)!.win.document.__vortexAXOwner).toBeUndefined();
  });

  it("discards an in-flight AX reply after a child reload and never redirects old claim/cleanup into its replacement", async () => {
    const api = setup();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.hooks.ax = async () => { entered(); await gate; };
    const pending = api.observe();
    await waiting;
    const old = api.navigate(17);
    const replacement = api.frames.get(17)!;
    replacement.win.document.documentElement.setAttribute("data-vtx-frame-ax", "replacement");
    replacement.win.document.querySelector("#b0").setAttribute("data-vtx-ax", "replacement:0");
    release();
    const response: any = await pending;
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(response.result).toBeUndefined();
    const calls = api.execute.mock.calls.map(([details]: any) => details);
    for (const details of calls.filter((details) => ["claim", "retire"].includes(details.args?.[0]))) {
      expect(details.target.documentIds).toEqual([old.documentId]);
      expect(await api.inject(details)).toEqual([]);
    }
    const oldScan = calls.find((details) => String(details.func).includes("const scanRoot"));
    expect(await api.inject(oldScan)).toEqual([]);
    expect(replacement.win.document.documentElement.getAttribute("data-vtx-frame-ax")).toBe("replacement");
    expect(replacement.win.document.querySelector("#b0").getAttribute("data-vtx-ax")).toBe("replacement:0");
    expect(replacement.win.document.__vortexAXOwner).toBeUndefined();
    api.hooks.ax = undefined;
    const next: any = await api.observe();
    expect(next.result.elements[0].name).toBe("AX 17 b0");
  });

  it("does not discard a stable child AX overlay for an unrelated sibling navigation", async () => {
    const api = setup();
    api.hooks.afterInjection = (details) => { if (details.args?.[0] === "check") api.navigate(41); };
    const response: any = await api.observe();
    expect(response.result.elements[0].name).toBe("AX 17 b0");
  });

  it("pins non-AX scan leases and native shadow writes to same-URL cross-origin sibling documents", async () => {
    const api = setup(true);
    const response: any = await api.observe({ frameId: undefined, frames: [17, 41], includeAX: false });
    expect(response.error).toBeUndefined();
    const calls = api.execute.mock.calls.map(([details]: any) => details);
    const scans = calls.filter((details) => String(details.func).includes("const scanRoot"));
    expect(scans).toHaveLength(2);
    for (const scan of scans) {
      const request = scan.args[9];
      const frame = api.frames.get(request.frameId)!;
      expect(scan.target).toEqual({ tabId: 42, documentIds: [frame.documentId] });
      expect(calls.some((call) => call.args?.[0] === "scan.claim" && call.target.documentIds[0] === frame.documentId)).toBe(true);
      expect(frame.win.document.querySelector("#host").shadowRoot.querySelector("button").hasAttribute("data-vortex-rid")).toBe(true);
      expect((await api.inject(scan))[0].result).toBeNull();
    }
    const before = api.frames.get(41)!.win.document.documentElement.outerHTML;
    const wrongDocument = { ...scans[0], target: { tabId: 42, documentIds: [api.frames.get(41)!.documentId] } };
    expect((await api.inject(wrongDocument))[0].result).toBeNull();
    expect(api.frames.get(41)!.win.document.documentElement.outerHTML).toBe(before);
    const stale = scans[0];
    api.navigate(9);
    expect(await api.inject(stale)).toEqual([]);
    expect(api.frames.get(17)!.win.document.__vortexScanOwner).toBeUndefined();
    expect(api.frames.get(17)!.win.document.querySelector("#host").shadowRoot.querySelector("button").hasAttribute("data-vortex-rid")).toBe(false);
  });

  it("preserves the child pagination monitor during real stamping/retire and delayed old-token cleanup", async () => {
    const api = setup();
    let oldRetire: any;
    api.hooks.ownership = (details) => {
      if (details.args?.[0] === "retire" && !oldRetire) { oldRetire = details; return true; }
      return false;
    };
    await api.observe({ paginate: true, maxElements: 10 });
    const current: any = await api.observe({ paginate: true, maxElements: 10 });
    expect(current.error).toBeUndefined();
    await api.inject(oldRetire);
    const page: any = await api.observe({ cursor: current.result.nextCursor });
    expect(page.error).toBeUndefined();
    api.frames.get(17)!.win.document.querySelector("#b0").setAttribute("data-page-change", "yes");
    const stale: any = await api.observe({ cursor: current.result.nextCursor });
    expect(stale.error?.code).toBe("STALE_SNAPSHOT");
  });
});
