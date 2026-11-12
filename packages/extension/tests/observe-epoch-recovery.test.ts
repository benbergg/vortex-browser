import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: async () => undefined }));
const windows: JSDOM["window"][] = [];
type Kind = "listener" | "ax" | "scan";
const ownerKey = (kind: Kind) => kind === "listener" ? "__vortexListenerOwner" : kind === "scan" ? "__vortexScanOwner" : "__vortexAXOwner";

// Real serialized MAIN injections and CDP functions, routed to a retained document.
// This models protocol execution, not Chrome worlds or OOPIF transport.
async function setup() {
  const dom = new JSDOM(`<!doctype html><body><div id="direct">Direct action</div><div id="drop">Drop files here</div><div id="host"></div>${Array.from({ length: 12 }, (_, i) => `<button id="b${i}">Native ${i}</button>`).join("")}</body>`, {
    url: "https://recovery.example/", pretendToBeVisual: true, runScripts: "outside-only",
  });
  windows.push(dom.window);
  const win = dom.window as any;
  win.Date.now = () => Date.now();
  win.CSS = { escape: (value: string) => value };
  win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
  Object.defineProperties(win.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 80 }, offsetHeight: { configurable: true, get: () => 30 },
  });
  win.Element.prototype.scrollIntoView = () => {};
  win.document.elementFromPoint = () => null;
  const shadow = win.document.querySelector("#host").attachShadow({ mode: "open" });
  shadow.innerHTML = `<div id="shadow-click">Shadow action</div><div id="shadow-drop">Shadow drop</div>`;
  const frame = { frameId: 0, parentFrameId: -1, documentId: "retained-document", url: win.location.href };
  const calls: any[] = [];
  const writes: any[] = [];
  const hooks = { holdRetire: false, dropHandoverReply: null as "empty" | "error" | null, wrongProbeIdentity: false as Kind | false };
  const droppedReplies = new Set<string>();
  const handoverStates: Array<{ kind: Kind; state: any }> = [];
  const inject = async (details: any) => {
    if (details.target.documentIds && !details.target.documentIds.includes(frame.documentId)) return [];
    if (!details.target.documentIds && !details.target.frameIds?.includes(0)) return [];
    if (details.world !== "MAIN") throw new Error("Injection must use MAIN world");
    const result = await win.eval(`(${String(details.func)})`)(...structuredClone(details.args ?? []));
    return [{ frameId: 0, documentId: frame.documentId, result: structuredClone(result) }];
  };
  vi.stubGlobal("chrome", {
    scripting: { executeScript: vi.fn(async (details: any) => {
      calls.push(details);
      if (hooks.holdRetire && ["retire", "listener.retire"].includes(details.args?.[0])) return [];
      const result = await inject(details);
      if (details.args?.[0] === "ownership.handover") {
        const kind = details.args[1] as Kind;
        handoverStates.push({ kind, state: structuredClone(win.document[ownerKey(kind)]) });
        if (hooks.dropHandoverReply && !droppedReplies.has(kind)) {
          droppedReplies.add(kind);
          if (hooks.dropHandoverReply === "error") throw new Error("Lost handover acknowledgement");
          return [];
        }
      }
      if (hooks.wrongProbeIdentity === details.args?.[1] && details.args?.[0] === "ownership.probe") return result.map((entry) => ({ ...entry, documentId: "wrong-document" }));
      return result;
    }) },
    tabs: { get: vi.fn().mockResolvedValue({ id: 42, url: frame.url }) },
    webNavigation: { getAllFrames: vi.fn(async () => [{ ...frame }]), onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } },
    runtime: { lastError: null },
  });
  const nodes = new Map<number, any>();
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const id = (node: any) => {
    if (!ids.has(node)) ids.set(node, nextId++);
    const value = ids.get(node)!; nodes.set(value, node); return value;
  };
  const project = (node: any): any => ({
    nodeName: node.nodeName, backendNodeId: id(node), nodeId: id(node),
    attributes: node.attributes ? Array.from(node.attributes).flatMap((attr: any) => [attr.name, attr.value]) : [],
    children: Array.from(node.children ?? []).map(project), ...(node.shadowRoot ? { shadowRoots: [project(node.shadowRoot)] } : {}),
  });
  const markerNodes = [win.document.querySelector("#direct"), win.document.querySelector("#drop"), shadow.querySelector("#shadow-click"), shadow.querySelector("#shadow-drop")];
  const runWrite = (write: any) => win.eval(`(${write.params.functionDeclaration})`).apply(write.node, structuredClone(write.params.arguments.map((arg: any) => arg.value)));
  const debuggerMgr = {
    attach: vi.fn().mockResolvedValue(undefined), enableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(async (_tab: number, method: string, params: any) => {
      if (method === "Runtime.evaluate") return { result: { objectId: "document" } };
      if (method === "DOMDebugger.getEventListeners") return { listeners: markerNodes.map((node, i) => ({ type: i % 2 ? "drop" : "click", backendNodeId: id(node) })) };
      if (method === "DOM.getDocument") return { root: project(win.document) };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: params.backendNodeIds };
      if (method === "DOM.resolveNode") return { object: { objectId: String(params.nodeId) } };
      if (method === "Runtime.callFunctionOn") {
        const write = { node: nodes.get(Number(params.objectId)), params }; writes.push(write);
        return { result: { value: runWrite(write) } };
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [win.document, shadow].flatMap((root) => Array.from(root.querySelectorAll("[data-vtx-ax]"))).map((node: any) => ({
        nodeId: String(id(node)), backendDOMNodeId: id(node), role: { value: "button" }, name: { value: `AX ${node.id}` },
      })) };
      return {};
    }),
  };
  const restart = async (withDebugger = true) => {
    vi.resetModules();
    const worker = await import("../src/handlers/observe.js");
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    worker.registerObserveHandlers(router, withDebugger ? debuggerMgr as any : undefined);
    return (args: Record<string, unknown> = {}) => router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: args.cursor ? args : { frames: "main", includeAX: true, detail: "full", ...args }, requestId: "epoch-recovery", tabId: 42 });
  };
  const observe = await restart();
  const claim = (kind: Kind) => calls.find((call) => call.args?.[0] === (kind === "listener" ? "listener.claim" : "claim"));
  return { win, frame, calls, hooks, writes, runWrite, inject, restart, observe, claim, markerNodes, handoverStates };
}

async function protocol(kind: Kind, paginated = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const api = await setup();
  api.hooks.holdRetire = !paginated;
  const response: any = await api.observe(paginated ? { paginate: true, maxElements: 5 } : {});
  expect(response.error).toBeUndefined();
  const claim = api.claim(kind);
  const a = claim.args[1];
  const b = { ...a, epoch: `${kind}-worker-B`, order: 1, token: `${kind}-token-B`, deadline: Date.now() + 60_000 };
  const { transitionOwnership } = await import("../src/handlers/observe-ownership-recovery.js");
  const op = async (action: "probe" | "handover", request = b, expected: any = null) => (await api.inject({
    target: { tabId: 42, documentIds: [request.documentId] }, world: "MAIN",
    func: transitionOwnership, args: [`ownership.${action}`, kind, request, expected],
  }))[0]?.result;
  const own = async (action: "claim" | "retire", request: any) => (await api.inject({
    ...claim, args: [kind === "listener" ? `listener.${action}` : action, request],
  }))[0].result;
  const owner = () => api.win.document[ownerKey(kind)];
  const exited = () => api.win.document[kind === "listener" ? "__vortexListenerExitedEpochs" : "__vortexAXExitedEpochs"];
  return { ...api, response, a, b, op, own, owner, exited };
}

afterEach(() => {
  for (const win of windows.splice(0)) win.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

for (const kind of ["listener", "ax"] as const) {
  describe(`${kind} worker epoch recovery`, () => {
    it.each(["retired", "expired"] as const)("recovers a retained %s document after a real worker module restart", async (state) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const api = await setup();
      api.hooks.holdRetire = state === "expired";
      const first: any = await api.observe();
      expect(first.error).toBeUndefined();
      expect(first.result.elements.some((element: any) => kind === "listener" ? element.listenerInteractive : element.name.startsWith("AX "))).toBe(true);
      const a = api.claim(kind).args[1];
      if (state === "expired") vi.setSystemTime(a.deadline + 1);
      else expect(api.win.document[ownerKey(kind)].owner).toBeNull();
      api.hooks.holdRetire = false;
      const observeB = await api.restart();
      const second: any = await observeB();
      expect(second.error).toBeUndefined();
      const claims = api.calls.filter((call) => call.args?.[0] === (kind === "listener" ? "listener.claim" : "claim"));
      expect(claims[1].args[1].epoch).not.toBe(a.epoch);
      expect(second.result.elements.some((element: any) => kind === "listener" ? element.listenerInteractive : element.name.startsWith("AX "))).toBe(true);
      if (kind === "listener") {
        expect(second.result.elements.filter((element: any) => element.listenerInteractive)).toHaveLength(2);
        expect(second.result.elements.filter((element: any) => element.dropzoneInteractive)).toHaveLength(2);
      }
      expect(api.calls.some((call) => call.args?.[0] === "ownership.handover" && call.args[1] === kind && call.target.documentIds[0] === api.frame.documentId)).toBe(true);
    });

    it.each(["active owner", "wrong probe identity"] as const)("keeps the real handler fail-closed on %s", async (reason) => {
      const api = await setup();
      api.hooks.holdRetire = reason === "active owner";
      const first: any = await api.observe();
      expect(first.error).toBeUndefined();
      const a = structuredClone(api.win.document[ownerKey(kind)]);
      api.hooks.wrongProbeIdentity = reason === "wrong probe identity" ? kind : false;
      const observeB = await api.restart();
      const second: any = await observeB();
      expect(second.error).toBeUndefined();
      expect(second.result.elements.some((element: any) => kind === "listener" ? element.listenerInteractive : element.name.startsWith("AX "))).toBe(false);
      expect(api.win.document[ownerKey(kind)]).toEqual(a);
      if (reason === "wrong probe identity") expect(api.calls.some((call) => call.args?.[0] === "ownership.handover" && call.args[1] === kind)).toBe(false);
    });

    it.each(["empty", "error"] as const)("confirms a lost %s handover reply through observe and retires normally", async (loss) => {
      const api = await setup();
      const first: any = await api.observe();
      expect(first.error).toBeUndefined();
      api.hooks.dropHandoverReply = loss;
      const observeB = await api.restart();
      const second: any = await observeB();
      expect(second.error).toBeUndefined();
      expect(second.result.elements.some((element: any) => kind === "listener" ? element.listenerInteractive : element.name.startsWith("AX "))).toBe(true);
      const states = api.handoverStates.filter((entry) => entry.kind === kind).map((entry) => entry.state);
      expect(states).toHaveLength(2);
      expect(states[1]).toEqual(states[0]);
      const final = api.win.document[ownerKey(kind)];
      expect(final.owner).toBeNull();
      expect(final.retired).toBe(true);
      expect(final.epoch).toBe(states[0].epoch);
      expect(final.highWater).toBe(states[0].highWater);
    });

    it("recovers the pre-revision owner layout while retaining document routing", async () => {
      const api = await protocol(kind);
      await api.own("retire", api.a);
      const owner = api.owner();
      delete owner.revision;
      if (kind === "ax") {
        for (const key of ["documentId", "frameId", "order", "token", "retired", "ancestorFrameIds"]) delete owner[key];
      }
      expect(await api.op("handover", api.b, await api.op("probe"))).toBe(true);
      expect(api.owner().documentId).toBe(api.frame.documentId);
      expect(api.exited().has(api.a.epoch)).toBe(true);
    });

    it("uses revision for changed retirements without inventing changes for idempotent AX retirement", async () => {
      const api = await protocol(kind);
      await api.own("retire", api.a);
      const expected = await api.op("probe");
      await api.own("retire", api.a);
      const before = structuredClone(api.owner());
      expect(before.highWater).toBe(expected.highWater);
      expect(before.owner).toBe(expected.owner);
      if (kind === "listener") {
        expect(before.revision).toBeGreaterThan(expected.revision);
        expect(await api.op("handover", api.b, expected)).toBe(false);
        expect(api.owner()).toEqual(before);
        expect(api.exited()).toBeUndefined();
      } else {
        expect(before).toEqual(expected);
        expect(await api.op("handover", api.b, expected)).toBe(true);
      }
    });

    it("rejects an active owner, expired incoming lease and wrong identity without any mutation", async () => {
      const api = await protocol(kind);
      const before = structuredClone(api.owner());
      const html = api.win.document.documentElement.outerHTML;
      const expected = await api.op("probe");
      expect(expected.epoch).toBe(api.a.epoch);
      expect(api.owner()).toEqual(before);
      expect(await api.op("handover", api.b, expected)).toBe(false);
      expect(api.owner()).toEqual(before);
      expect(api.win.document.documentElement.outerHTML).toBe(html);
      expect(await api.op("handover", { ...api.b, frameId: 17 }, expected)).toBe(false);
      expect(await api.op("handover", { ...api.b, documentId: "replacement" }, expected)).toBeUndefined();
      await api.own("retire", api.a);
      const retired = structuredClone(api.owner());
      const retiredExpected = await api.op("probe");
      expect(await api.op("handover", { ...api.b, deadline: Date.now() }, retiredExpected)).toBe(false);
      expect(api.owner()).toEqual(retired);
      expect(api.exited()).toBeUndefined();
      // The explicit retirement above may clean markers; failed probes/CAS never do.
      expect(before.epoch).toBe(api.a.epoch);
      expect(html).toContain("data-vtx-ax");
    });

    it("hands over a retired owner and confirms a lost response without resetting high water", async () => {
      const api = await protocol(kind);
      await api.own("retire", api.a);
      const expected = await api.op("probe");
      expect(await api.op("handover", api.b, expected)).toBe(true);
      const established = structuredClone(api.owner());
      expect(await api.op("handover", api.b, expected)).toBe(true);
      expect(api.owner()).toEqual(established);
      const next = { ...api.b, order: 10, token: "later-same-epoch" };
      expect(await api.own("claim", next)).toBe(true);
      const advanced = structuredClone(api.owner());
      expect(await api.op("handover", api.b, expected)).toBe(false);
      expect(api.owner()).toEqual(advanced);
      expect(api.owner().highWater).toBe(10);
      expect(api.exited().has(api.a.epoch)).toBe(true);
    });

    it("recovers an expired owner without retirement and leaves all markers unchanged", async () => {
      const api = await protocol(kind);
      vi.setSystemTime(api.a.deadline + 1);
      const b = { ...api.b, deadline: Date.now() + 60_000 };
      const html = api.win.document.documentElement.outerHTML;
      const shadow = api.win.document.querySelector("#host").shadowRoot.innerHTML;
      expect(await api.op("handover", b, await api.op("probe", b))).toBe(true);
      expect(api.owner().owner).toBe(b.token);
      expect(api.win.document.documentElement.outerHTML).toBe(html);
      expect(api.win.document.querySelector("#host").shadowRoot.innerHTML).toBe(shadow);
    });

    it("rejects a changed expected state and allows only one competing handover", async () => {
      const api = await protocol(kind);
      const expected = await api.op("probe");
      const nextA = { ...api.a, order: api.a.order + 1, token: "new-A" };
      expect(await api.own("claim", nextA)).toBe(true);
      await api.own("retire", nextA);
      const before = structuredClone(api.owner());
      expect(await api.op("handover", api.b, expected)).toBe(false);
      expect(api.owner()).toEqual(before);
      expect(api.exited()).toBeUndefined();
      const current = await api.op("probe");
      const c = { ...api.b, epoch: "competitor-C", token: "token-C" };
      const results = await Promise.all([api.op("handover", api.b, current), api.op("handover", c, current)]);
      expect(results.sort()).toEqual([false, true]);
      expect(api.owner().owner).toBe(api.b.token);
      expect(api.exited().size).toBe(1);
    });

    it("keeps independent A/B tombstones after A→B→C and rejects all retired-epoch replays", async () => {
      const api = await protocol(kind);
      await api.own("retire", api.a);
      const expectedA = await api.op("probe");
      expect(await api.op("handover", api.b, expectedA)).toBe(true);
      await api.own("retire", api.b);
      const scanA = api.calls.find((call) => String(call.func).includes("const scanRoot"));
      const scanOwner = api.win.document.__vortexScanOwner;
      const lease = { ...scanOwner, order: scanOwner.highWater + 1, token: "current-scan-C" };
      const { updateScanOwnership } = await import("../src/handlers/observe-scan-ownership.js");
      expect((await api.inject({ target: scanA.target, world: "MAIN", func: updateScanOwnership, args: ["scan.claim", lease] }))[0].result).toBe(true);
      const c = { ...api.b, epoch: "worker-C", token: "token-C", scanToken: lease.token };
      expect(await api.op("handover", c, await api.op("probe", c))).toBe(true);
      const currentArgs = [...scanA.args];
      currentArgs[9] = lease;
      if (kind === "listener") {
        const writeA = api.writes[0];
        const writeC = { ...writeA, params: structuredClone(writeA.params) };
        writeC.params.arguments[3].value = [c];
        expect(api.runWrite(writeC)).toBe(true);
        expect(api.runWrite(writeA)).toBe(false);
        currentArgs[currentArgs.length - 2] = c;
        const current = (await api.inject({ ...scanA, args: currentArgs }))[0].result;
        expect(current.elements.some((element: any) => element.listenerInteractive)).toBe(true);
        const stale = (await api.inject(scanA))[0].result;
        expect(stale).toBeNull();
      } else {
        currentArgs[currentArgs.length - 1] = c;
        expect((await api.inject({ ...scanA, args: currentArgs }))[0].result.axStamped).toBe(true);
        const markers = Array.from(api.win.document.querySelectorAll("[data-vtx-ax]")).map((node: any) => node.getAttribute("data-vtx-ax"));
        expect((await api.inject(scanA))[0].result).toBeNull();
        expect(Array.from(api.win.document.querySelectorAll("[data-vtx-ax]")).map((node: any) => node.getAttribute("data-vtx-ax"))).toEqual(markers);
      }
      await api.own("retire", c);
      const before = structuredClone(api.owner());
      for (const old of [api.a, api.b]) {
        expect(await api.own("claim", { ...old, order: 999 })).toBe(false);
        expect(await api.own("retire", { ...old, order: 999 })).toBe(false);
        expect(await api.op("handover", { ...old, deadline: Date.now() + 60_000 }, await api.op("probe", c))).toBe(false);
      }
      expect(await api.op("handover", api.b, expectedA)).toBe(false);
      expect(api.owner()).toEqual(before);
      expect([...api.exited()].sort()).toEqual([api.a.epoch, api.b.epoch].sort());
      delete api.win.document[ownerKey(kind)];
      expect(await api.own("claim", api.a)).toBe(false);
      expect(await api.own("retire", api.b)).toBe(false);
      expect(api.exited().size).toBe(2);
    });

    it("does not touch a real pagination monitor or DOM during probe/handover and old retirement", async () => {
      const api = await protocol(kind, true);
      const states = api.win.__vortexPageSnapshots;
      const monitor = states[api.response.result.snapshotId];
      expect(monitor.check()).toBe(true);
      const before = { ...monitor };
      const html = api.win.document.documentElement.outerHTML;
      const observer = new api.win.MutationObserver(() => {});
      observer.observe(api.win.document, { attributes: true, subtree: true });
      const expected = await api.op("probe");
      expect(await api.op("handover", api.b, expected)).toBe(true);
      expect(await api.own("retire", api.a)).toBe(false);
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      expect(api.win.document.documentElement.outerHTML).toBe(html);
      expect(api.win.__vortexPageSnapshots).toBe(states);
      expect(states[api.response.result.snapshotId]).toBe(monitor);
      expect(monitor).toEqual(before);
      expect(monitor.check()).toBe(true);
      const next: any = await api.observe({ cursor: api.response.result.nextCursor });
      expect(next.error).toBeUndefined();
      api.win.document.querySelector("#b0").textContent = "Real mutation";
      expect(monitor.check()).toBe(false);
    });
  });
}

// Stage two: real scan replay and document write-lease regression coverage.
async function scanReplaySetup(options: { includeAX?: boolean; withDebugger?: boolean; paginateA?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const api = await setup();
  const shadow = api.win.document.querySelector("#host").shadowRoot;
  shadow.append(Object.assign(api.win.document.createElement("button"), { id: "shadow-native", textContent: "Shadow native" }));
  let nonce = 0;
  vi.spyOn(api.win.Math, "random").mockImplementation(() => ++nonce / 100);
  const observeA = await api.restart(options.withDebugger !== false);
  const first: any = await observeA({ includeAX: options.includeAX ?? true, ...(options.paginateA ? { paginate: true, maxElements: 5 } : {}) });
  expect(first.error).toBeUndefined();
  const scanA = api.calls.find((call) => String(call.func).includes("const scanRoot"));
  expect(scanA).toBeDefined();
  vi.setSystemTime(Date.now() + 1); // Distinct snapshot IDs despite reset module counters.
  const observeB = await api.restart(options.withDebugger !== false);
  const second: any = await observeB({ includeAX: options.includeAX ?? true, paginate: true, maxElements: 5 });
  expect(second.error).toBeUndefined();
  expect(second.result.nextCursor).toBeTypeOf("string");
  const monitor = api.win.__vortexPageSnapshots[second.result.snapshotId];
  expect(monitor.check()).toBe(true);
  expect(Date.now()).toBeLessThan(scanA.args[8]);
  // Pin the original production function/arguments to this exact document. The
  // document routing alone is not authority to replay its consumed scan lease.
  const replay = () => api.inject({ ...scanA, target: { tabId: 42, documentIds: [api.frame.documentId] } });
  const next = () => observeB({ cursor: second.result.nextCursor });
  return { ...api, shadow, scanA, first, second, monitor, replay, next };
}

async function scanLeaseSetup() {
  const api = await setup();
  expect((await api.observe({ includeAX: false }) as any).error).toBeUndefined();
  const scan = api.calls.find((call) => String(call.func).includes("const scanRoot"));
  const a = scan.args[9];
  const { updateScanOwnership, updatePageSnapshot } = await import("../src/handlers/observe-scan-ownership.js");
  const { transitionOwnership } = await import("../src/handlers/observe-ownership-recovery.js");
  const execute = async (func: any, args: any[]) => (await api.inject({ target: scan.target, world: "MAIN", func, args }))[0].result;
  const own = (action: string, request: any) => execute(updateScanOwnership, [`scan.${action}`, request]);
  const op = (action: string, request: any, expected: any = null) => execute(transitionOwnership, [`ownership.${action}`, "scan", request, expected]);
  return { ...api, scan, a, own, op, execute, updatePageSnapshot };
}

describe("ordinary scan write ownership across worker epochs", () => {
  it.each([
    { label: "AX and listener", includeAX: true, withDebugger: true },
    { label: "non-AX", includeAX: false, withDebugger: true },
    { label: "without debugger", includeAX: false, withDebugger: false },
  ])("does not let an old $label scan overwrite a published native shadow RID", async (options) => {
    const api = await scanReplaySetup(options);
    const button = api.shadow.querySelector("#shadow-native");
    const rid = button.getAttribute("data-vortex-rid");
    expect(rid).toBeTypeOf("string");
    const { getSnapshotEntry } = await import("../src/lib/snapshot-store.js");
    const element = getSnapshotEntry(api.second.result.snapshotId)!.elements.find((el) => el.selector === `[data-vortex-rid="${rid}"]`);
    expect(element).toBeDefined();
    // Resolve the selector actually published for actions, not a fabricated one.
    const index = element!.pageNodeIndex!;
    const selector = element!.selector;
    expect(index).toBeGreaterThanOrEqual(0);
    expect(api.monitor.validate(index, selector)).toBe(button);
    expect(api.shadow.querySelector(selector)).toBe(button);
    if (options.includeAX) {
      const a = api.claim("ax").args[1];
      expect(api.win.document.__vortexAXOwner.epoch).not.toBe(a.epoch);
      expect(api.win.document.__vortexAXExitedEpochs.has(a.epoch)).toBe(true);
    }
    await api.replay();
    const next: any = await api.next();
    expect({ rid: button.getAttribute("data-vortex-rid"), selectorMatches: api.shadow.querySelector(selector) === button,
      monitorValid: api.monitor.check(), cursorError: next.error?.code }).toEqual({
      rid, selectorMatches: true, monitorValid: true, cursorError: undefined,
    });
  });

  it("does not let an old scoped scan clean a newer RID outside its scope", async () => {
    // Deep duplicate paths force the actual production light-DOM RID fallback.
    vi.useFakeTimers({ toFake: ["Date"] });
    const api = await setup();
    const nested = `<div>`.repeat(10) + `<button>Deep duplicate</button>` + `</div>`.repeat(10);
    api.win.document.body.insertAdjacentHTML("beforeend", nested + nested);
    const observeA = await api.restart(false);
    expect((await observeA({ target: "#b0", includeAX: false }) as any).error).toBeUndefined();
    const scanA = api.calls.find((call) => String(call.func).includes("const scanRoot"));
    const observeB = await api.restart(false);
    const second: any = await observeB({ includeAX: false, paginate: true, maxElements: 5 });
    expect(second.error).toBeUndefined();
    const node = api.win.document.querySelector("[data-vortex-rid]");
    expect(node?.tagName).toBe("BUTTON");
    expect(node).not.toBe(api.win.document.querySelector("#b0"));
    const rid = node.getAttribute("data-vortex-rid");
    const monitor = api.win.__vortexPageSnapshots[second.result.snapshotId];
    expect(monitor.check()).toBe(true);
    expect(Date.now()).toBeLessThan(scanA.args[8]);
    await api.inject({ ...scanA, target: { tabId: 42, documentIds: [api.frame.documentId] } });
    expect({ rid: node.getAttribute("data-vortex-rid"), monitorValid: monitor.check() }).toEqual({ rid, monitorValid: true });
  });

  it("does not let an old scan rewrite an unchanged react marker under a new monitor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const api = await setup();
    const button = api.win.document.querySelector("#b0");
    button.style.cursor = "pointer";
    const observeA = await api.restart(false);
    expect((await observeA({ includeAX: false }) as any).error).toBeUndefined();
    const scanA = api.calls.find((call) => String(call.func).includes("const scanRoot"));
    const observeB = await api.restart(false);
    const second: any = await observeB({ includeAX: false, paginate: true, maxElements: 5 });
    expect(second.error).toBeUndefined();
    const monitor = api.win.__vortexPageSnapshots[second.result.snapshotId];
    expect(button.getAttribute("data-vortex-react-clickable")).toBe("1");
    expect(api.win.document.querySelector("[data-vortex-rid]")).toBeNull();
    expect(monitor.check()).toBe(true);
    const set = vi.spyOn(button, "setAttribute");
    await api.inject({ ...scanA, target: { tabId: 42, documentIds: [api.frame.documentId] } });
    expect({ writes: set.mock.calls.filter(([name]) => name === "data-vortex-react-clickable"), monitorValid: monitor.check() })
      .toEqual({ writes: [], monitorValid: true });
  });

  it("does not let an old paginated scan replace a new published monitor", async () => {
    const api = await scanReplaySetup({ paginateA: true });
    expect(api.first.result.snapshotId).not.toBe(api.second.result.snapshotId);
    const oldMonitor = api.win.__vortexPageSnapshots[api.first.result.snapshotId];
    await api.replay();
    expect({ oldMonitorSame: api.win.__vortexPageSnapshots[api.first.result.snapshotId] === oldMonitor,
      newMonitorSame: api.win.__vortexPageSnapshots[api.second.result.snapshotId] === api.monitor,
      newMonitorValid: api.monitor.check(), cursorError: (await api.next() as any).error?.code })
      .toEqual({ oldMonitorSame: true, newMonitorSame: true, newMonitorValid: true, cursorError: undefined });
  });

  it.each([true, false])("fails closed without documentId, debugger=%s", async (withDebugger) => {
    const api = await setup();
    const button = Object.assign(api.win.document.createElement("button"), { id: "shadow-native", textContent: "Shadow native" });
    button.style.cursor = "pointer";
    api.win.document.querySelector("#host").shadowRoot.append(button);
    delete (api.frame as { documentId?: string }).documentId;
    const observe = await api.restart(withDebugger);
    await observe({ includeAX: false, paginate: true, maxElements: 5 });
    expect({ rid: button.getAttribute("data-vortex-rid"), react: button.getAttribute("data-vortex-react-clickable"),
      monitors: Object.keys(api.win.__vortexPageSnapshots ?? {}) }).toEqual({ rid: null, react: null, monitors: [] });
  });

  it("keeps normal current shadow selectors and a published monitor after the scan deadline", async () => {
    const api = await scanReplaySetup({ includeAX: false, withDebugger: false });
    const button = api.shadow.querySelector("#shadow-native");
    const selector = `[data-vortex-rid="${button.getAttribute("data-vortex-rid")}"]`;
    const index = api.monitor.nodes.indexOf(button);
    vi.setSystemTime(api.scanA.args[8] + 2);
    expect(api.monitor.check()).toBe(true);
    expect(api.monitor.validate(index, selector)).toBe(button);
    expect((await api.next() as any).error).toBeUndefined();
    button.textContent = "Real mutation";
    expect(api.monitor.check()).toBe(false);
  });

  it("admits only one same-epoch order/token and consumes a scan just once", async () => {
    const api = await scanLeaseSetup();
    const b = { ...api.a, order: api.a.order + 1, token: "same-epoch-B" };
    const loser = { ...b, token: "same-epoch-loser" };
    expect(await Promise.all([api.own("claim", b), api.own("claim", loser)])).toEqual([true, false]);
    expect(await api.own("claim", { ...b, deadline: b.deadline + 1 })).toBe(false);
    const args = [...api.scan.args]; args[9] = b;
    const before = api.win.document.body.innerHTML;
    const calls = await Promise.all([api.inject({ ...api.scan, args }), api.inject({ ...api.scan, args })]);
    expect(calls.filter((results) => results[0].result !== null)).toHaveLength(1);
    expect(api.win.document.body.innerHTML).toBe(before);
    expect(await api.own("check", b)).toBe(true);
    expect(await api.own("retire", b)).toBe(true);
    expect(await api.own("claim", b)).toBe(false);
    expect(await api.own("claim", api.a)).toBe(false);
  });

  it("retains early retirement and expired high-water tombstones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const api = await scanLeaseSetup();
    const b = { ...api.a, order: api.a.order + 10, token: "retire-before-claim" };
    expect(await api.own("retire", b)).toBe(true);
    expect(await api.own("claim", b)).toBe(false);
    expect(await api.own("claim", api.a)).toBe(false);
    const c = { ...b, order: b.order + 1, token: "current" };
    expect(await api.own("claim", c)).toBe(true);
    vi.setSystemTime(c.deadline);
    expect(await api.own("check", c)).toBe(false);
    expect(await api.own("claim", { ...b, deadline: c.deadline + 60_000 })).toBe(false);
    expect(api.win.document.__vortexScanOwner.highWater).toBe(c.order);
  });

  it("rejects an unexpired epoch, lets one CAS contender win, and fences A/B after A→B→C", async () => {
    const api = await scanLeaseSetup();
    const active = { ...api.a, order: api.a.order + 1, token: "active-A" };
    expect(await api.own("claim", active)).toBe(true);
    const b = { ...active, epoch: "scan-worker-B", order: 1, token: "B" };
    const loser = { ...b, epoch: "scan-worker-loser", token: "loser" };
    expect(await api.op("handover", b, await api.op("probe", b))).toBe(false);
    await api.own("retire", active);
    const expected = await api.op("probe", b);
    expect(await Promise.all([api.op("handover", b, expected), api.op("handover", loser, expected)])).toEqual([true, false]);
    const advanced = { ...b, order: 2, token: "advanced-B" };
    expect(await api.own("claim", advanced)).toBe(true);
    const before = structuredClone(api.win.document.__vortexScanOwner);
    expect(await api.op("handover", b, expected)).toBe(false);
    expect(api.win.document.__vortexScanOwner).toEqual(before);
    await api.own("retire", advanced);
    const c = { ...b, epoch: "scan-worker-C", token: "C" };
    expect(await api.op("handover", c, await api.op("probe", c))).toBe(true);
    const current = structuredClone(api.win.document.__vortexScanOwner);
    for (const stale of [active, advanced]) {
      expect(await api.own("claim", stale)).toBe(false);
      expect(await api.own("retire", stale)).toBe(false);
      expect(await api.op("handover", stale, await api.op("probe", c))).toBe(false);
    }
    expect(api.win.document.__vortexScanOwner).toEqual(current);
    expect([...api.win.document.__vortexScanExitedEpochs].sort()).toEqual([active.epoch, b.epoch].sort());
    delete api.win.document.__vortexScanOwner;
    expect(await api.own("claim", active)).toBe(false);
    expect(await api.own("claim", advanced)).toBe(false);
  });

  it.each(["empty", "error"] as const)("confirms a lost scan CAS %s reply without resetting high water", async (loss) => {
    const api = await setup();
    expect((await api.observe({ includeAX: false }) as any).error).toBeUndefined();
    api.hooks.dropHandoverReply = loss;
    const observe = await api.restart(false);
    expect((await observe({ includeAX: false }) as any).error).toBeUndefined();
    const states = api.handoverStates.filter((item) => item.kind === "scan");
    expect(states).toHaveLength(2);
    expect(states[0].state).toEqual(states[1].state);
    expect(api.win.document.__vortexScanOwner.highWater).toBe(states[0].state.highWater);
    expect(api.win.document.__vortexScanOwner.retired).toBe(true);
  });

  it("rejects wrong scan probe provenance before any new writes", async () => {
    const api = await setup();
    expect((await api.observe({ includeAX: false }) as any).error).toBeUndefined();
    const before = api.win.document.body.innerHTML;
    api.hooks.wrongProbeIdentity = "scan";
    const observe = await api.restart(false);
    const response: any = await observe({ includeAX: false });
    expect(response.error?.code).toBe("STALE_SNAPSHOT");
    expect(api.win.document.body.innerHTML).toBe(before);
    expect(api.calls.some((call) => call.args?.[0] === "ownership.handover" && call.args[1] === "scan")).toBe(false);
  });

  it("fences actual RID/React writes if geometry re-enters and revokes the lease", async () => {
    const api = await scanLeaseSetup();
    const shadow = api.win.document.querySelector("#host").shadowRoot;
    const button = Object.assign(api.win.document.createElement("button"), { textContent: "Native shadow" });
    button.style.cursor = "pointer";
    shadow.append(button);
    const b = { ...api.a, order: api.a.order + 1, token: "geometry-scan" };
    expect(await api.own("claim", b)).toBe(true);
    const geometry = button.getBoundingClientRect;
    let revoked = false;
    button.getBoundingClientRect = () => {
      revoked = true;
      api.win.document.__vortexScanOwner = { ...b, highWater: b.order + 1, owner: "new-owner", token: "new-owner", retired: false };
      return geometry.call(button);
    };
    const args = [...api.scan.args]; args[9] = b;
    await expect(api.inject({ ...api.scan, args })).rejects.toThrow("Observe lease revoked");
    expect(revoked).toBe(true);
    expect(button.hasAttribute("data-vortex-rid")).toBe(false);
    expect(button.hasAttribute("data-vortex-react-clickable")).toBe(false);
  });

  it("does not bind a monitor after its constructor revokes the scan lease", async () => {
    const api = await scanLeaseSetup();
    const b = { ...api.a, order: api.a.order + 1, token: "monitor-construction" };
    expect(await api.own("claim", b)).toBe(true);
    const Observer = api.win.MutationObserver;
    const observe = vi.spyOn(Observer.prototype, "observe");
    let revoked = false;
    api.win.MutationObserver = class extends Observer {
      constructor(callback: MutationCallback) {
        super(callback);
        revoked = true;
        api.win.document.__vortexScanOwner = { ...b, highWater: b.order + 1, owner: "replacement", token: "replacement", retired: false };
      }
    };
    const args = [...api.scan.args]; args[7] = "revoked-monitor"; args[9] = b;
    expect((await api.inject({ ...api.scan, args }))[0].result).toBeNull();
    expect(revoked).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(api.win.__vortexPageSnapshots["revoked-monitor"]).toBeUndefined();
  });

  it("does not let old timer/finalize/cleanup capabilities alter a newer monitor", async () => {
    const api = await setup();
    const timers = vi.spyOn(api.win, "setTimeout");
    const first: any = await api.observe({ includeAX: false, paginate: true, maxElements: 5 });
    expect(first.error).toBeUndefined();
    const a = api.calls.find((call) => String(call.func).includes("const scanRoot")).args[9];
    const oldTimers = timers.mock.calls.filter(([, delay]) => Number(delay) >= 60_000).map(([callback]) => callback);
    expect(oldTimers.length).toBeGreaterThan(0);
    const second: any = await api.observe({ includeAX: false, paginate: true, maxElements: 5 });
    expect(second.error).toBeUndefined();
    const monitor = api.win.__vortexPageSnapshots[second.result.snapshotId];
    const { updatePageSnapshot } = await import("../src/handlers/observe-scan-ownership.js");
    for (const callback of oldTimers) (callback as () => void)();
    for (const action of ["finalize", "cleanup"] as const) {
      expect((await api.inject({ target: { tabId: 42, documentIds: [a.documentId] }, world: "MAIN", func: updatePageSnapshot,
        args: [action, second.result.snapshotId, a, Date.now(), 60_000] }))[0].result).toBe(false);
    }
    expect(api.win.__vortexPageSnapshots[second.result.snapshotId]).toBe(monitor);
    expect(monitor.check()).toBe(true);
    expect((await api.observe({ cursor: second.result.nextCursor }) as any).error).toBeUndefined();
  });

  it.each([false, true])("keeps a new cursor after late old cleanup (controlled overlap: %s)", async (overlap) => {
    vi.useFakeTimers();
    const api = await setup();
    const { getSnapshotEntry } = await import("../src/lib/snapshot-store.js");
    const published: any = await api.observe({ includeAX: false, paginate: true, maxElements: 5 });
    expect(published.error).toBeUndefined();
    const execute = vi.mocked(chrome.scripting.executeScript);
    const original = execute.getMockImplementation()!;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let held = false;
    const cleanups: string[] = [];
    execute.mockImplementation(async (details: any) => {
      if (details.args?.[0] === "cleanup") {
        cleanups.push(details.args[1]);
        if (!held && details.args[1] === published.result.snapshotId) {
          held = true;
          await cleanup;
        }
      }
      return Reflect.apply(original, undefined, [details]);
    });
    const old = api.observe({ includeAX: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(held).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await old as any).error?.code).toBe("TIMEOUT");
    if (overlap) {
      // Test-only admission of the successor, without changing production queue
      // code: the queue WeakMap is keyed by the scripting API object. The same
      // handler, shared snapshot maps, injector and document remain in place.
      // This tests the safety precondition of releasing a timed-out gate, not
      // a claim that today's still-held gate already permits this overlap.
      chrome.scripting = { ...chrome.scripting };
    }
    let next: any;
    const successor = api.observe({ includeAX: false, paginate: true, maxElements: 5 }).then((response) => { next = response; });
    await vi.advanceTimersByTimeAsync(1);
    if (overlap) {
      expect(next?.error).toBeUndefined();
      expect(next?.result?.nextCursor).toBeTypeOf("string");
      expect(getSnapshotEntry(next.result.snapshotId)).toBeDefined();
      expect(api.win.__vortexPageSnapshots[next.result.snapshotId].check()).toBe(true);
    } else {
      expect(next).toBeUndefined();
    }
    releaseCleanup();
    await vi.advanceTimersByTimeAsync(1);
    await successor;
    expect(next.error).toBeUndefined();
    expect(next.result.nextCursor).toBeTypeOf("string");
    expect.soft(getSnapshotEntry(next.result.snapshotId)).toBeDefined();
    expect.soft(api.win.__vortexPageSnapshots[next.result.snapshotId]).toBeDefined();
    const page: any = await api.observe({ cursor: next.result.nextCursor });
    expect.soft(page.error).toBeUndefined();
    expect.soft(cleanups).not.toContain(next.result.snapshotId);
  });

  it("already rejects an expired old scan before any ordinary writes", async () => {
    const api = await scanReplaySetup({ includeAX: false, withDebugger: false });
    const before = api.shadow.innerHTML;
    vi.setSystemTime(api.scanA.args[8] + 1);
    expect((await api.replay())[0].result).toBeNull();
    expect(api.shadow.innerHTML).toBe(before);
    expect(api.monitor.check()).toBe(true);
  });
});
