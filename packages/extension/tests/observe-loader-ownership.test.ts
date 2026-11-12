import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { pageSideInstaller } from "../build/page-side-installer.js";
import { updateScanOwnership, updatePageSnapshot } from "../src/handlers/observe-scan-ownership.js";

let bundle: string;
let loaderBundle: string;
const windows: JSDOM["window"][] = [];

beforeAll(async () => {
  // Match the real page-side build, in memory: no dist write or extension reload.
  const output: any = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL("../src/page-side/dom-resolve.ts", import.meta.url)),
        formats: ["iife"],
        name: "vortexPageSide_dom_resolve",
      },
      emptyOutDir: false,
      minify: "esbuild",
      sourcemap: false,
      target: "chrome120",
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  bundle = result.output.find((item: any) => item.type === "chunk").code;
  // The production plugin AND outer production minifier must preserve serialization.
  const compiled: any = await build({
    configFile: false, logLevel: "silent", plugins: [pageSideInstaller()],
    resolve: { alias: { "@vortex-browser/shared": fileURLToPath(new URL("../../shared/src/index.ts", import.meta.url)) } },
    build: {
      write: false, emptyOutDir: false, minify: "esbuild", sourcemap: false,
      lib: { entry: fileURLToPath(new URL("../src/adapter/page-side-loader.ts", import.meta.url)), formats: ["iife"], name: "vortexLoaderProbe" },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const compiledResult = Array.isArray(compiled) ? compiled[0] : compiled;
  loaderBundle = compiledResult.output.find((item: any) => item.type === "chunk").code;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup() {
  vi.resetModules();
  let version = 0;
  const frames = new Map<number, { frameId: number; parentFrameId: number; documentId?: string; url: string; win: any }>();
  const committed: Array<(event: any) => void> = [];
  const makeFrame = (frameId: number) => {
    const url = `https://loader.example/frame-${frameId}`;
    const dom = new JSDOM(`<!doctype html><body>${Array.from({ length: 14 }, (_, i) => `<button id="b${i}">Button ${i}</button>`).join("")}</body>`, {
      url, pretendToBeVisual: true, runScripts: "outside-only",
    });
    windows.push(dom.window);
    const win = dom.window as any;
    win.Date.now = () => Date.now();
    win.CSS = { escape: (value: string) => value };
    win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
    win.Element.prototype.scrollIntoView = () => {};
    win.document.elementFromPoint = () => win.document.querySelector("button");
    const frame = { frameId, parentFrameId: frameId === 0 ? -1 : 0, documentId: `loader-document-${++version}`, url, win };
    frames.set(frameId, frame);
    return frame;
  };
  makeFrame(0);
  makeFrame(17);
  const hooks: { before?: (details: any) => Promise<void>; after?: (details: any) => Promise<void> } = {};
  const execute = vi.fn(async (details: any) => {
    await hooks.before?.(details);
    // Resolve targets at delivery. This models a possible late frameIds delivery,
    // not Chrome navigation scheduling. A documentIds target cannot drift to B.
    const selected = [...frames.values()].filter((frame) => details.target.documentIds
      ? details.target.documentIds.includes(frame.documentId)
      : (details.target.frameIds ?? [0]).includes(frame.frameId));
    const results = [];
    for (const frame of selected) {
      let result: unknown;
      if (details.files) {
        expect(details.files).toEqual(["page-side/dom-resolve.js"]);
        frame.win.eval(bundle);
      } else if (details.func) {
        result = await frame.win.eval(`(${String(details.func)})`)(...structuredClone(details.args ?? []));
      }
      results.push({ frameId: frame.frameId, documentId: frame.documentId, result });
    }
    await hooks.after?.(details);
    return results;
  });
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), onRemoved: { addListener: vi.fn() } },
    runtime: { getManifest: () => ({ host_permissions: ["<all_urls>"] }) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [...frames.values()].map(({ win: _win, ...frame }) => ({ ...frame, documentLifecycle: "active" }))),
      onCommitted: { addListener: (listener: (event: any) => void) => committed.push(listener) },
    },
    scripting: { executeScript: execute },
  });
  const loader = await import("../src/adapter/page-side-loader.js");
  const { registerObserveHandlers } = await import("../src/handlers/observe.js");
  const { ActionRouter } = await import("../src/lib/router.js");
  const router = new ActionRouter();
  registerObserveHandlers(router, undefined as any);
  const observe = (args: Record<string, unknown> = {}) => router.dispatch({ type: "tool_request", tool: "observe.snapshot",
    args: args.cursor ? args : { frameId: 17, includeAX: false, ...args }, requestId: "loader-ownership", tabId: 42 });
  const navigate = (frameId: number) => {
    const old = frames.get(frameId)!;
    const frame = makeFrame(frameId);
    committed.forEach((listener) => listener({ tabId: 42, frameId, documentId: frame.documentId, url: frame.url }));
    return old;
  };
  const isLoader = (details: any) => Boolean(details.files ||
    (details.args?.[0]?.token && details.args[0].documentId));
  const holdFile = (phase: "delivery" | "ack" = "delivery", rejection?: Error) => {
    const entered = deferred();
    const release = deferred();
    let first = true;
    const hook = async (details: any) => {
      if (isLoader(details) && first) {
        first = false;
        entered.resolve();
        await release.promise;
        if (rejection) throw rejection;
      }
    };
    if (phase === "delivery") hooks.before = hook; else hooks.after = hook;
    return { entered: entered.promise, release: release.resolve };
  };
  const run = (win: any, func: Function, args: unknown[]) => win.eval(`(${String(func)})`)(...structuredClone(args));
  const claim = (order = 1, frameId = 17) => {
    const frame = frames.get(frameId)!;
    const request = { documentId: frame.documentId!, frameId, epoch: "loader-worker", order,
      token: crypto.randomUUID(), deadline: Date.now() + 30_000 };
    expect(run(frame.win, updateScanOwnership, ["scan.claim", request])).toBe(true);
    return request;
  };
  const owned = (request: ReturnType<typeof claim>) => loader.loadPageSideModule(42, request.frameId, "dom-resolve", {
    request, track: <T>(work: Promise<T>) => work,
  });
  return { frames, execute, observe, navigate, holdFile, run, loader, claim, owned, isLoader };
}

afterEach(() => {
  for (const win of windows.splice(0)) win.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("observe loader document ownership", () => {
  it("loads a usable helper once per frame and reloads only a replaced frame", async () => {
    const api = await setup();
    await api.loader.loadPageSideModule(42, 0, "dom-resolve");
    await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    const top = api.frames.get(0)!.win.__vortexDomResolve;
    const child = api.frames.get(17)!.win.__vortexDomResolve;
    const button = api.frames.get(17)!.win.document.querySelector("button");
    expect(child.classifyHit(button, button)).toEqual({ ok: true });
    expect(child.queryDeep("#b0")).toBe(button);
    await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    expect(api.execute.mock.calls.filter(([details]) => details.files)).toHaveLength(2);
    api.frames.get(17)!.win.history.pushState({}, "", "#same-document");
    await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    expect(api.frames.get(17)!.win.__vortexDomResolve).toBe(child);
    api.navigate(17);
    await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    expect(api.frames.get(17)!.win.__vortexDomResolve.version).toBe(2);
    expect(api.frames.get(17)!.win.__vortexDomResolve).not.toBe(child);
    expect(api.frames.get(0)!.win.__vortexDomResolve).toBe(top);
  });

  it("does not install an old observe loader in a replacement document with a new scan owner", async () => {
    const api = await setup();
    const old = api.frames.get(17)!;
    const hold = api.holdFile();
    const pending = api.observe();
    await hold.entered;
    const request = structuredClone(old.win.document.__vortexScanOwner);
    api.navigate(17);
    const current = api.frames.get(17)!;
    const next = { ...request, documentId: current.documentId, epoch: "new-worker", order: 1, token: "new-request", deadline: Date.now() + 30_000 };
    expect(api.run(current.win, updateScanOwnership, ["scan.claim", next])).toBe(true);
    hold.release();
    await pending;
    expect(current.win.document.__vortexScanOwner.owner).toBe(next.token);
    expect(current.win.__vortexDomResolve).toBeUndefined();
  });

  it.each(["retired", "expired"] as const)("does not install a late observe loader after its same-document lease is %s", async (state) => {
    const api = await setup();
    const frame = api.frames.get(17)!;
    const hold = api.holdFile();
    const pending = api.observe();
    await hold.entered;
    const request = structuredClone(frame.win.document.__vortexScanOwner);
    if (state === "retired") expect(api.run(frame.win, updateScanOwnership, ["scan.retire", request])).toBe(true);
    else vi.spyOn(Date, "now").mockReturnValue(request.deadline + 1);
    hold.release();
    await pending;
    expect(frame.win.__vortexDomResolve).toBeUndefined();
  });

  it("does not let an obsolete loader acknowledgment skip loading the next document", async () => {
    const api = await setup();
    const hold = api.holdFile("ack");
    const pending = api.observe();
    await hold.entered;
    expect(api.frames.get(17)!.win.__vortexDomResolve.version).toBe(2);
    api.navigate(17);
    hold.release();
    await pending;
    const current: any = await api.observe();
    expect(current.error).toBeUndefined();
    expect(api.frames.get(17)!.win.__vortexDomResolve?.version).toBe(2);
  });

  it("does not invoke the loader when observe has no document identity", async () => {
    const api = await setup();
    api.frames.get(17)!.documentId = undefined;
    const response: any = await api.observe();
    expect(response.result?.elements ?? []).toHaveLength(0);
    expect(api.execute.mock.calls.some(([details]) => api.isLoader(details))).toBe(false);
    expect(api.frames.get(17)!.win.__vortexDomResolve).toBeUndefined();
  });

  it("does not borrow a newer same-document permit or let the old result replace its in-flight generation", async () => {
    const api = await setup();
    const win = api.frames.get(17)!.win;
    const previous = api.claim();
    const oldHold = api.holdFile();
    const old = api.owned(previous).then(() => undefined, (error) => error);
    await oldHold.entered;
    expect(api.run(win, updateScanOwnership, ["scan.retire", previous])).toBe(true);
    const current = api.claim(2);
    const nextHold = api.holdFile();
    const next = api.owned(current);
    oldHold.release();
    const oldError = await old;
    const wroteBeforeCurrentDelivery = win.__vortexDomResolve !== undefined;
    let duplicateSettled = false;
    const duplicate = api.owned(current).then(() => { duplicateSettled = true; });
    await Promise.resolve();
    const settledBeforeCurrentDelivery = duplicateSettled;
    nextHold.release();
    await Promise.all([next, duplicate]);
    expect(wroteBeforeCurrentDelivery).toBe(false);
    expect(settledBeforeCurrentDelivery).toBe(false);
    expect(oldError?.code).toBe("STALE_SNAPSHOT");
    expect(win.document.__vortexScanOwner.owner).toBe(current.token);
    expect(win.__vortexDomResolve.version).toBe(2);
  });

  it("checks a retired original permit again even when its helper is already installed", async () => {
    const api = await setup();
    const request = api.claim();
    const win = api.frames.get(17)!.win;
    await api.owned(request);
    const helper = win.__vortexDomResolve;
    expect(api.run(win, updateScanOwnership, ["scan.retire", request])).toBe(true);
    const error = await api.owned(request).then(() => undefined, (caught) => caught);
    expect(error?.code).toBe("STALE_SNAPSHOT");
    expect(win.__vortexDomResolve).toBe(helper);
  });

  it("propagates page guard errors without an unrestricted fallback and retries after failure", async () => {
    const api = await setup();
    const request = api.claim();
    const win = api.frames.get(17)!.win;
    const descriptor = Object.getOwnPropertyDescriptor(win.document, "__vortexScanOwner")!;
    Object.defineProperty(win.document, "__vortexScanOwner", {
      configurable: true, get: () => { throw new Error("page guard read failed"); },
    });
    const error = await api.owned(request).then(() => undefined, (caught) => caught);
    const installedAfterFailure = win.__vortexDomResolve;
    Object.defineProperty(win.document, "__vortexScanOwner", descriptor);
    await api.owned(request);
    expect(installedAfterFailure).toBeUndefined();
    expect(error?.message).toContain("page guard read failed");
    expect(api.execute.mock.calls.some(([details]) => details.files)).toBe(false);
    expect(win.__vortexDomResolve.version).toBe(2);
  });

  it("checks ownership at the actual write after an existing resolver getter revokes it", async () => {
    const api = await setup();
    const request = api.claim();
    const win = api.frames.get(17)!.win;
    let writes = 0;
    const descriptor = {
      configurable: true, enumerable: false,
      get: () => {
        api.run(win, updateScanOwnership, ["scan.retire", request]);
        return undefined;
      },
      set: () => { writes += 1; },
    };
    Object.defineProperty(win, "__vortexDomResolve", descriptor);
    const error = await api.owned(request).then(() => undefined, (caught) => caught);
    expect(writes).toBe(0);
    expect(error?.code).toBe("STALE_SNAPSHOT");
    expect(Object.getOwnPropertyDescriptor(win, "__vortexDomResolve")).toEqual(descriptor);
  });

  it("leaves an existing resolver property and ordinary unscoped calls interoperable", async () => {
    const api = await setup();
    const win = api.frames.get(17)!.win;
    await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    const helper = win.__vortexDomResolve;
    const setter = vi.fn();
    const descriptor = { configurable: true, enumerable: false, get: () => helper, set: setter };
    Object.defineProperty(win, "__vortexDomResolve", descriptor);
    const request = api.claim();
    await api.owned(request);
    expect(api.run(win, updateScanOwnership, ["scan.retire", request])).toBe(true);
    api.loader._resetPageSideLoader();
    await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    expect(Object.getOwnPropertyDescriptor(win, "__vortexDomResolve")).toEqual(descriptor);
    expect(setter).not.toHaveBeenCalled();
    expect(helper.queryDeep("#b0")).toBe(win.document.querySelector("button"));
  });

  it.each(["success", "failure"] as const)("does not let a late ordinary loader %s replace a newer cache generation", async (outcome) => {
    const api = await setup();
    const oldHold = api.holdFile("ack", outcome === "failure" ? new Error("old injection failed") : undefined);
    const previous = api.loader.loadPageSideModule(42, 17, "dom-resolve").then(() => undefined, (error) => error);
    await oldHold.entered;
    api.navigate(17);
    const nextHold = api.holdFile();
    const next = api.loader.loadPageSideModule(42, 17, "dom-resolve");
    await nextHold.entered;
    oldHold.release();
    const oldError = await previous;
    let duplicateSettled = false;
    const duplicate = api.loader.loadPageSideModule(42, 17, "dom-resolve").then(() => { duplicateSettled = true; });
    // Drain only microtasks, not timers or the intentionally held injection.
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeDelivery = duplicateSettled;
    const installedBeforeDelivery = api.frames.get(17)!.win.__vortexDomResolve;
    const deliveryCount = api.execute.mock.calls.filter(([details]) => details.files).length;
    nextHold.release();
    await Promise.all([next, duplicate]);
    expect(settledBeforeDelivery).toBe(false);
    expect(installedBeforeDelivery).toBeUndefined();
    expect(deliveryCount).toBe(2);
    expect(oldError?.message).toBe(outcome === "failure" ? "old injection failed" : undefined);
    expect(api.frames.get(17)!.win.__vortexDomResolve.version).toBe(2);
  });

  it("keeps the same-tab gate while raw owned injection outlives the loader timeout", async () => {
    const api = await setup();
    vi.useFakeTimers();
    const hold = api.holdFile();
    const pending = api.observe({ frameId: undefined });
    await hold.entered;
    await vi.advanceTimersByTimeAsync(3_001);
    const response: any = await pending;
    expect(response.error).toBeUndefined();
    expect(response.result.elements.filter((element: any) => element.frameId === 17)).toHaveLength(14);
    expect(api.frames.get(17)!.win.__vortexDomResolve.version).toBe(2);
    expect(api.frames.get(0)!.win.__vortexDomResolve).toBeUndefined();
    const claims = api.execute.mock.calls.filter(([details]) => details.args?.[0] === "scan.claim").length;
    let queuedSettled = false;
    const queued = api.observe({ frameId: 0 }).then((result) => { queuedSettled = true; return result; });
    await vi.advanceTimersByTimeAsync(1);
    const settledBeforeRaw = queuedSettled;
    const claimsBeforeRaw = api.execute.mock.calls.filter(([details]) => details.args?.[0] === "scan.claim").length;
    hold.release();
    const next: any = await queued;
    expect(settledBeforeRaw).toBe(false);
    expect(claimsBeforeRaw).toBe(claims);
    expect(next.error).toBeUndefined();
    expect(next.result.elements.length).toBeGreaterThan(0);
  });

  it("serializes the actual minified production loader function into another document realm", async () => {
    const api = await setup();
    const workerRealm = api.frames.get(0)!.win;
    workerRealm.chrome = (globalThis as any).chrome;
    workerRealm.eval(loaderBundle);
    const request = api.claim();
    const context = { request, track: <T>(work: Promise<T>) => work };
    await workerRealm.vortexLoaderProbe.loadPageSideModule(42, 17, "dom-resolve", context);
    const win = api.frames.get(17)!.win;
    const button = win.document.querySelector("button");
    expect(win.__vortexDomResolve.classifyHit(button, button)).toEqual({ ok: true });
    expect(win.__vortexDomResolve.queryDeep("#b0")).toBe(button);
    expect(workerRealm.__vortexDomResolve).toBeUndefined();
    expect(api.execute.mock.calls.some(([details]) => details.files)).toBe(false);
    expect(api.run(win, updateScanOwnership, ["scan.retire", request])).toBe(true);
    delete win.__vortexDomResolve;
    await expect(workerRealm.vortexLoaderProbe.loadPageSideModule(42, 17, "dom-resolve", context))
      .rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(win.__vortexDomResolve).toBeUndefined();
  });

  it.each(["clock", "helper", "version"] as const)("rechecks its original lease after a %s hook retires it in the serialized production installer", async (hook) => {
    const api = await setup();
    const win = api.frames.get(17)!.win;
    const workerRealm = api.frames.get(0)!.win;
    workerRealm.chrome = (globalThis as any).chrome;
    workerRealm.eval(loaderBundle);
    if (hook !== "clock") await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    const helper = win.__vortexDomResolve;
    const request = api.claim();
    let calls = 0;
    let retired = false;
    const retire = () => {
      if (++calls === (hook === "clock" ? 2 : 1)) {
        retired = api.run(win, updateScanOwnership, ["scan.retire", request]);
      }
    };
    if (hook === "clock") {
      const now = win.Date.now;
      win.Date.now = () => { retire(); return now(); };
    } else if (hook === "helper") {
      Object.defineProperty(win, "__vortexDomResolve", {
        configurable: true, get: () => { retire(); return helper; },
      });
    } else {
      Object.defineProperty(helper, "version", {
        configurable: true, get: () => { retire(); return 2; },
      });
    }
    const error = await workerRealm.vortexLoaderProbe.loadPageSideModule(42, 17, "dom-resolve", {
      request, track: <T>(work: Promise<T>) => work,
    }).then(() => undefined, (caught: any) => caught);
    expect(retired).toBe(true);
    expect(win.document.__vortexScanOwner.retired).toBe(true);
    if (hook === "clock") expect(win.__vortexDomResolve).toBeUndefined();
    expect(error?.code).toBe("STALE_SNAPSHOT");
    // Ordinary three-argument loading does not require the retired observe lease.
    await workerRealm.vortexLoaderProbe.loadPageSideModule(42, 17, "dom-resolve");
    expect(win.__vortexDomResolve.queryDeep("#b0")).toBe(win.document.querySelector("button"));
    if (hook !== "clock") expect(win.__vortexDomResolve).toBe(helper);
  });

  it.each(["throw", "reject"] as const)("does not strand tracking or cache after a scripting %s", async (failure) => {
    const api = await setup();
    const request = api.claim();
    const outstanding = new Set<Promise<unknown>>();
    const context = { request, track: <T>(work: Promise<T>) => {
      outstanding.add(work);
      void work.then(() => outstanding.delete(work), () => outstanding.delete(work));
      return work;
    } };
    api.execute.mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("scripting unavailable");
      return Promise.reject(new Error("scripting unavailable"));
    });
    await expect(api.loader.loadPageSideModule(42, 17, "dom-resolve", context)).rejects.toThrow("scripting unavailable");
    expect(outstanding.size).toBe(0);
    expect(api.frames.get(17)!.win.__vortexDomResolve).toBeUndefined();
    await api.loader.loadPageSideModule(42, 17, "dom-resolve", context);
    expect(outstanding.size).toBe(0);
    expect(api.frames.get(17)!.win.__vortexDomResolve.version).toBe(2);
  });

  it.each(["documentId", "frameId", "result"] as const)("rejects an invalid owned injection %s acknowledgment and retries", async (field) => {
    const api = await setup();
    const request = api.claim();
    api.execute.mockImplementationOnce(async () => [{ documentId: request.documentId, frameId: request.frameId, result: true,
      [field]: field === "frameId" ? 99 : field === "documentId" ? "another-document" : false }]);
    await expect(api.owned(request)).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(api.frames.get(17)!.win.__vortexDomResolve).toBeUndefined();
    await api.owned(request);
    expect(api.frames.get(17)!.win.__vortexDomResolve.version).toBe(2);
  });

  it("rejects owned installation for modules without an owned protocol", async () => {
    const api = await setup();
    const request = api.claim();
    await expect(api.loader.loadPageSideModule(42, 17, "actionability", { request, track: <T>(work: Promise<T>) => work }))
      .rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("preserves an installed helper and the real published monitor on duplicate bundle delivery", async () => {
    const api = await setup();
    const response: any = await api.observe({ paginate: true, maxElements: 2 });
    expect(response.error).toBeUndefined();
    const win = api.frames.get(17)!.win;
    const token = response.result.snapshotId;
    const item = win.__vortexPageSnapshots[token];
    const helper = win.__vortexDomResolve;
    const request = structuredClone(win.document.__vortexScanOwner);
    expect(request.retired).toBe(true);
    await expect(api.owned(request)).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(win.__vortexDomResolve).toBe(helper);
    expect(win.__vortexPageSnapshots[token]).toBe(item);
    api.loader._resetPageSideLoader();
    await api.loader.loadPageSideModule(42, 17, "dom-resolve");
    expect(win.__vortexDomResolve).toBe(helper);
    expect(win.__vortexPageSnapshots[token]).toBe(item);
    expect(api.run(win, updatePageSnapshot, ["check", token, request])).toBe(true);
  });
});
