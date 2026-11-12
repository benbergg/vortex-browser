import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { stubDocumentChrome } from "./helpers/document-chrome.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { applyOverlay } from "../src/handlers/observe-ax-overlay.js";

// These doubles exercise extension decisions, not Chrome's extension↔CDP frame mapping
// or OOPIF session routing. Those require an actual Chrome extension/browser test.
const realms: JSDOM[] = [];
const frames = [
  { frameId: 0, parentFrameId: -1, url: "https://main.example/" },
  { frameId: 17, parentFrameId: 0, url: "https://child.example/" },
  { frameId: 29, parentFrameId: 17, url: "https://nested.example/" },
];
const viewport = (width: number, height: number) => ({ width, height, scrollY: 0, scrollHeight: height });
function page(url: string, title: string, width: number, name: string) {
  return {
    url, title, viewport: viewport(width, 600),
    elements: [{ index: 0, tag: "button", role: "button", name, bbox: { x: 0, y: 0, w: 10, h: 10 }, visible: true, inViewport: true, attrs: {}, _sel: "button" }],
    candidateCount: 1, truncated: false,
  };
}
function setup(options: { deniedFrames?: number[]; deniedScanFrames?: number[]; hostPermissions?: string[]; debuggerMgr?: any } = {}) {
  const pages: Record<number, any> = {
    0: page(frames[0].url, "Main", 1200, "main button"),
    17: page(frames[1].url, "Child", 700, "child button"),
    29: page(frames[2].url, "Nested", 400, "nested button"),
  };
  const documents = frames.map((frame) => {
    const spec = pages[frame.frameId];
    const dom = new JSDOM("<!doctype html><body><button></button></body>", { url: frame.url, runScripts: "outside-only", pretendToBeVisual: true });
    realms.push(dom);
    const win = dom.window as any;
    win.document.title = spec.title;
    win.document.querySelector("button").textContent = spec.elements[0].name;
    Object.defineProperty(win, "innerWidth", { value: spec.viewport.width });
    Object.defineProperty(win, "innerHeight", { value: spec.viewport.height });
    Object.defineProperty(win.document.documentElement, "scrollHeight", { value: spec.viewport.scrollHeight });
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 });
    win.document.elementFromPoint = () => null;
    for (const child of frames.filter((candidate) => candidate.parentFrameId === frame.frameId)) {
      const iframe = win.document.createElement("iframe");
      iframe.src = child.url;
      win.document.body.appendChild(iframe);
    }
    return { ...frame, dom };
  });
  const shim = stubDocumentChrome(documents, options.hostPermissions);
  const executeScript = Object.assign(shim.executeScript, { frames: shim.frames });
  const execute = executeScript.getMockImplementation()!;
  executeScript.mockImplementation((details: any) => {
    const id = details.target.documentIds
      ? shim.frames.find((frame) => frame.documentId === details.target.documentIds[0])?.frameId
      : details.target.frameIds?.[0] ?? 0;
    // Revoke access at the scan injection, after the real document claim succeeds.
    if (options.deniedFrames?.includes(id) ||
        (options.deniedScanFrames?.includes(id) && details.func?.toString().includes("const scanDocument = document"))) {
      throw new Error("Cannot access contents of the page. Extension manifest must request permission to access this host.");
    }
    // This case models a frame that cannot be injected, not a post-claim scan failure.
    if (pages[id] === null) throw new Error("Frame was removed");
    return Reflect.apply(execute, undefined, [details]);
  });
  const router = new ActionRouter();
  registerObserveHandlers(router, options.debuggerMgr);
  const observe = async (args: Record<string, unknown>) => router.dispatch({ type: "tool_request", tool: "observe.snapshot", args, requestId: "frame-test", tabId: 42 });
  return { observe, pages, executeScript };
}
afterEach(() => { for (const dom of realms.splice(0)) dom.window.close(); vi.unstubAllGlobals(); });

describe("frame metadata and evidence", () => {
  it("keeps main metadata separate when only a nested frame is observed", async () => {
    const { observe } = setup();
    const response: any = await observe({ frameId: 29, includeAX: false });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ url: frames[0].url, title: "Main", viewport: viewport(1200, 600) });
    expect(response.result.frames).toEqual([expect.objectContaining({ frameId: 29, parentFrameId: 17, url: frames[2].url, title: "Nested", viewport: viewport(400, 600), scanned: true })]);
    expect(response.result.elements.map((e: any) => [e.frameId, e.name])).toEqual([[29, "nested button"]]);
  });

  it("reads only main document metadata when observing a child", async () => {
    const { observe, executeScript } = setup();
    await observe({ frameId: 29, includeAX: false });
    const mainCalls = executeScript.mock.calls.filter(([details]: any) => {
      const frameId = details.target.documentIds
        ? executeScript.frames.find((frame) => frame.documentId === details.target.documentIds[0])?.frameId
        : details.target.frameIds?.[0] ?? 0;
      return !details.target.allFrames && frameId === 0 && !details.func.toString().includes("getBoundingClientRect");
    });
    expect(mainCalls).toHaveLength(1);
    expect(mainCalls[0][0].func.toString()).not.toContain("querySelectorAll");
  });

  it("marks main metadata unknown when access is denied", async () => {
    const { observe } = setup({ deniedFrames: [0] });
    const response: any = await observe({ frameId: 29, includeAX: false });
    expect(response.error).toBeUndefined();
    expect(response.result.mainMetadataStatus).toBe("unavailable");
    expect(response.result.viewport).toBeUndefined();
    expect(response.result.elements[0].frameId).toBe(29);
  });

  it("exposes selected frame metadata without replacing the main header", async () => {
    const { observe } = setup();
    const response: any = await observe({ frameId: 29, includeAX: false });
    expect(response.error).toBeUndefined();
    expect(response.result.frames).toEqual([expect.objectContaining({ frameId: 29, parentFrameId: 17, url: frames[2].url, title: "Nested", viewport: viewport(400, 600), scanned: true })]);
  });

  it("includes permitted cross-origin nested frames without mixing local element indexes", async () => {
    const { observe } = setup();
    const response: any = await observe({ frames: "all-permitted", includeAX: false });
    expect(response.error).toBeUndefined();
    expect(response.result.elements.map((e: any) => [e.frameId, e.index, e.name])).toEqual([
      [0, 0, "main button"], [17, 1, "child button"], [29, 2, "nested button"],
    ]);
    expect(response.result.frames.find((f: any) => f.frameId === 29).parentFrameId).toBe(17);
  });

  it("retains a nested cross-origin frame only when its own origin is permitted", async () => {
    const { observe } = setup({ hostPermissions: ["https://main.example/*", "https://child.example/*", "https://nested.example/*"] });
    const allowed: any = await observe({ frames: "all-permitted", includeAX: false });
    expect(allowed.error).toBeUndefined();
    expect(allowed.result.elements.map((e: any) => e.frameId)).toEqual([0, 17, 29]);

    const blocked = setup({ hostPermissions: ["https://main.example/*", "https://child.example/*"] });
    const denied: any = await blocked.observe({ frames: "all-permitted", includeAX: false });
    expect(denied.error).toBeUndefined();
    expect(denied.result.elements.map((e: any) => e.frameId)).toEqual([0, 17]);
  });

  it("reports permission revoked after the document claim without losing accessible frames", async () => {
    const { observe, executeScript } = setup({ deniedScanFrames: [17] });
    const response: any = await observe({ frames: "all-permitted", includeAX: false });
    const claim = executeScript.mock.calls.findIndex(([details]: any) => details.args?.[0] === "scan.claim" && details.args[1].frameId === 17);
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(await executeScript.mock.results[claim].value).toMatchObject([{ frameId: 17, result: true }]);
    expect(response.error).toBeUndefined();
    expect(response.result.elements.map((e: any) => e.frameId)).toEqual([0, 29]);
    expect(response.result.frames.find((f: any) => f.frameId === 17)).toMatchObject({ scanned: false, elementCount: 0, scanError: "permission-denied" });
  });

  it("retains accessible frames when an otherwise permitted frame cannot be injected", async () => {
    const { observe, pages } = setup();
    pages[17] = null;
    const response: any = await observe({ frames: "all-permitted", includeAX: false });
    expect(response.error).toBeUndefined();
    expect(response.result.frames.find((f: any) => f.frameId === 17)).toMatchObject({ scanned: false, elementCount: 0 });
    expect(response.result.elements.map((e: any) => e.frameId)).toEqual([0, 29]);
  });

  it("reports child AX unavailable rather than claiming an unverified OOPIF mapping", async () => {
    const debuggerMgr = {
      attach: vi.fn().mockRejectedValue(new Error("No target with given id")),
      enableDomain: vi.fn().mockRejectedValue(new Error("No target with given id")),
      sendCommand: vi.fn().mockRejectedValue(new Error("No target with given id")),
    };
    const { observe } = setup({ debuggerMgr });
    const response: any = await observe({ frameId: 29, includeAX: true });
    expect(response.error).toBeUndefined();
    const child = response.result.frames.find((f: any) => f.frameId === 29);
    expect(child.axStatus).toBe("unavailable");
    expect(response.result.elements[0].semanticSource).not.toBe("ax");
  });

  it("distinguishes AX hits from DOM and heuristic evidence without changing nameSource", () => {
    const elements: any[] = [
      { role: "button", name: "DOM label", semanticSource: "dom", nameSource: "aria-label" },
      { role: "button", name: "DOM only", semanticSource: "dom", nameSource: "aria-label" },
      { role: "div", name: "inferred", semanticSource: "heuristic" },
    ];
    applyOverlay(elements, new Map([[0, 100]]), new Map([[100, { nodeId: "ax-1", role: { value: "button" }, name: { value: "AX name", sources: [{ type: "attribute", attribute: "aria-label" }] } }]]), new Map());
    expect(elements.map((e) => e.semanticSource)).toEqual(["ax", "dom", "heuristic"]);
    expect(elements[0].name).toBe("AX name");
    expect(elements[0].nameSource).toBe("aria-label");
  });
});
