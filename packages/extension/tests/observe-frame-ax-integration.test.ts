import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";

// Controlled executeScript/CDP fixtures. They do not prove Chrome's protocol routing.
vi.mock("../src/handlers/observe-js-listener.js", () => ({
  markListenerElements: vi.fn().mockResolvedValue({ mechanism: "domDebugger" }),
}));

const realms: JSDOM[] = [];

function setup(options: { unavailable?: number; navigate?: number; timeout?: number; missingMarker?: number; duplicateMarker?: number } = {}) {
  const ids = [17, 41];
  const cdpIds: Record<number, string> = { 17: "opaque-alpha", 41: "opaque-beta" };
  const documents = new Map<number, JSDOM>();
  for (const id of [0, ...ids]) {
    const dom = new JSDOM("<!doctype html><body></body>", { url: id ? "https://site.example/same" : "https://site.example/", runScripts: "outside-only", pretendToBeVisual: true });
    documents.set(id, dom);
    realms.push(dom);
    const win = dom.window as any;
    win.Date.now = () => Date.now();
    win.CSS = { escape: String };
    win.document.elementFromPoint = () => null;
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    if (id) {
      const input = win.document.createElement("input");
      input.type = "password";
      input.setAttribute("aria-label", `DOM ${id}`);
      const button = win.document.createElement("button");
      button.textContent = `DOM second ${id}`;
      button.setAttribute("aria-controls", "external");
      const external = win.document.createElement("div");
      external.id = "external";
      win.document.body.append(input, button, external);
    }
  }

  let release!: (value: unknown) => void;
  let entered!: () => void;
  let onCommitted: ((details: { tabId: number; frameId: number }) => void) | undefined;
  const enteredAX = new Promise<void>((resolve) => { entered = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  const makeAX = (id: number) => ({ nodes: [{ nodeId: `ax-${id}`, backendDOMNodeId: id * 10,
    role: { value: "textbox" }, name: { value: `AX ${id}`, sources: [{ attribute: "aria-label" }] }, value: { value: "secret" },
    properties: [{ name: "controls", value: { relatedNodes: [{ backendDOMNodeId: id * 10 + 1 }] } },
      { name: "owns", value: { relatedNodes: [{ backendDOMNodeId: id * 10 + 1 }] } }] },
    { nodeId: `second-${id}`, backendDOMNodeId: id * 10 + 1, role: { value: "button" }, name: { value: `Second ${id}` } }] });
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
      { frameId: 0, documentId: "doc-0", parentFrameId: -1, url: "https://site.example/" },
      ...ids.map((frameId) => ({ frameId, documentId: `doc-${frameId}`, parentFrameId: 0, url: "https://site.example/same" })),
    ]), onCommitted: { addListener: (fn: typeof onCommitted) => { onCommitted = fn; } } },
    scripting: { executeScript: vi.fn(async ({ target, func, args = [], files }: any) => {
      if (files || target.allFrames) return [];
      const id = target.documentIds
        ? ids.find((frameId) => target.documentIds[0] === `doc-${frameId}`)
        : target.frameIds?.[0] ?? 0;
      const dom = documents.get(id);
      if (!dom) return [];
      const win = dom.window as any;
      const injected = win.eval(`(${String(func)})`);
      // Preserve the existing unprovable-AX case without denying the scan lease.
      if (args[0] === "check" && options.navigate === id) injected("retire", structuredClone(args[1]));
      const result = injected(...structuredClone(args));
      return [{ frameId: id, documentId: `doc-${id}`, result }];
    }) },
  });
  const debuggerMgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn(async (_tab: number, method: string, params: any) => {
      if (method === "DOM.getDocument") return { root: { children: ids.map((id) => {
        const doc: Document = documents.get(id)!.window.document;
        const elements = [doc.querySelector("input")!, doc.querySelector("button")!];
        if (id === options.missingMarker) elements[0].removeAttribute("data-vtx-ax");
        const children = elements.map((element, index) => ({ backendNodeId: id * 10 + index,
          attributes: Array.from(element.attributes).flatMap(({ name, value }) => [name, value]) }));
        if (id === options.duplicateMarker) children.push({ backendNodeId: 9999, attributes: [...children[0].attributes] });
        return { frameId: cdpIds[id], ...(id === options.unavailable ? {} : { contentDocument: { children: [{
          attributes: Array.from(doc.documentElement.attributes).flatMap(({ name, value }) => [name, value]), children,
        }] } }) };
      }) } };
      if (method === "Accessibility.getFullAXTree") {
        const id = ids.find((candidate) => cdpIds[candidate] === params.frameId)!;
        if (id === options.timeout) { entered(); return delayed; }
        return makeAX(id);
      }
      return {};
    }),
  };
  const router = new ActionRouter();
  registerObserveHandlers(router, debuggerMgr as any);
  const observe = (format = "compact") => router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: { frames: ids, includeAX: true, format }, requestId: "children", tabId: 42 });
  return { observe, debuggerMgr, cdpIds, documents, enteredAX, navigate: (frameId: number) => onCommitted?.({ tabId: 42, frameId }), release: () => release(makeAX(options.timeout!)) };
}
afterEach(() => { for (const dom of realms.splice(0)) dom.window.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("child AX overlay lifecycle", () => {
  it.each(["compact", "full"])("isolates same-URL siblings and clears password values in %s", async (format) => {
    const { observe, debuggerMgr, cdpIds } = setup();
    const response: any = await observe(format);
    expect(response.error).toBeUndefined();
    for (const id of [17, 41]) {
      const el = response.result.elements.find((e: any) => e.frameId === id);
      expect(el).toMatchObject({ name: `AX ${id}`, nameSource: "aria-label", semanticSource: "ax" });
      expect(el.valueNow).toBeUndefined();
      const second = response.result.elements.find((e: any) => e.frameId === id && e.name === `Second ${id}`);
      expect(el.controls).toEqual([{ index: second.index }]);
      expect(el.owns).toEqual([{ index: second.index }]);
      expect(second.controls).toEqual([{ id: "external" }]);
      expect(response.result.frames.find((f: any) => f.frameId === id).axStatus).toBeUndefined();
      expect(debuggerMgr.sendCommand).toHaveBeenCalledWith(42, "Accessibility.getFullAXTree", { frameId: cdpIds[id] });
    }
  });
  it.each([{ unavailable: 17 }, { navigate: 17 }, { missingMarker: 17 }, { duplicateMarker: 17 }])("marks unprovable frame unavailable without affecting its sibling: %j", async (options) => {
    const response: any = await setup(options).observe();
    const broken = response.result.elements.find((e: any) => e.frameId === 17);
    expect(broken).toMatchObject({ name: "DOM 17" });
    expect(broken.semanticSource).not.toBe("ax");
    expect(response.result.frames.find((f: any) => f.frameId === 17).axStatus).toBe("unavailable");
    expect(response.result.elements.find((e: any) => e.frameId === 41).name).toBe("AX 41");
  });
  it("does not synthesize an AX element marker missing from the scanned DOM", async () => {
    const { observe, debuggerMgr, documents } = setup();
    const send = debuggerMgr.sendCommand.getMockImplementation()!;
    let removedMarker: string | null = null;
    debuggerMgr.sendCommand.mockImplementation(async (tab, method, params) => {
      if (method === "DOM.getDocument") {
        const input = documents.get(17)!.window.document.querySelector("input")!;
        const marker = input.getAttribute("data-vtx-ax");
        if (marker) { removedMarker = marker; input.removeAttribute("data-vtx-ax"); }
      }
      return Reflect.apply(send, undefined, [tab, method, params]);
    });
    const response: any = await observe();
    expect(removedMarker).toMatch(/.+:\d+$/);
    expect(response.error).toBeUndefined();
    expect(response.result.elements.find((el: any) => el.frameId === 17)).toMatchObject({ name: "DOM 17" });
    expect(response.result.frames.find((frame: any) => frame.frameId === 17).axStatus).toBe("unavailable");
    expect(response.result.elements.find((el: any) => el.frameId === 41).name).toBe("AX 41");
  });
  it("discards an AX response when its frame navigates during capture", async () => {
    const { observe, enteredAX, navigate, release } = setup({ timeout: 17 });
    const pending = observe();
    await enteredAX;
    navigate(17);
    release();
    const response: any = await pending;
    expect(response.result.frames.find((f: any) => f.frameId === 17).axStatus).toBe("unavailable");
    expect(response.result.elements.find((e: any) => e.frameId === 17).name).toBe("DOM 17");
    expect(response.result.elements.find((e: any) => e.frameId === 41).name).toBe("AX 41");
  });
  it("discards a timed-out late response without affecting another frame", async () => {
    vi.useFakeTimers();
    const { observe, enteredAX, release } = setup({ timeout: 17 });
    const pending = observe();
    await enteredAX;
    await vi.advanceTimersByTimeAsync(6_001);
    const response: any = await pending;
    expect(response.result.frames.find((f: any) => f.frameId === 17).axStatus).toBe("unavailable");
    expect(response.result.elements.find((e: any) => e.frameId === 41).name).toBe("AX 41");
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(response.result.elements.find((e: any) => e.frameId === 17).name).toBe("DOM 17");
  });
});
