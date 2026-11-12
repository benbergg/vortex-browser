import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { applyOverlay } from "../src/handlers/observe-ax-overlay.js";

import { stubDocumentChrome } from "./helpers/document-chrome.js";
vi.mock("../src/handlers/observe-js-listener.js", () => ({ markListenerElements: vi.fn().mockResolvedValue({ mechanism: "domDebugger" }) }));

afterEach(() => vi.unstubAllGlobals());

describe("observe semantic provenance", () => {
  it.each(["dom", "heuristic"])("marks applied masked AX state as AX instead of %s without copying masked fields", (source) => {
    const elements: any[] = [
      { role: "checkbox", name: "Public", maskedContent: true, semanticSource: source, state: { checked: false } },
      { role: "textbox", name: "Other", maskedContent: true, semanticSource: source },
    ];
    const nodes: any = new Map([
      [10, { nodeId: "state", role: { value: "checkbox" }, name: { value: "PRIVATE_AX_NAME" }, value: { value: "PRIVATE_AX_VALUE" },
        description: { value: "PRIVATE_AX_DESCRIPTION" }, properties: [{ name: "checked", value: { value: "mixed" } }, { name: "disabled", value: { value: true } }] }],
      [11, { nodeId: "text", role: { value: "textbox" }, name: { value: "PRIVATE_AX_NAME" }, description: { value: "PRIVATE_AX_DESCRIPTION" } }],
    ]);
    applyOverlay(elements, new Map([[0, 10], [1, 11]]), nodes, new Map());
    expect(elements[0]).toMatchObject({ role: "checkbox", name: "Public", state: { checked: "mixed", disabled: true }, semanticSource: "ax" });
    expect(elements[1]).toMatchObject({ name: "Other", semanticSource: source });
    expect(JSON.stringify(elements)).not.toContain("PRIVATE_AX");
  });
  it.each(["compact", "full"])("reports sources from the actual scan and AX overlay in %s", async (format) => {
    const dom = new JSDOM(`<!doctype html><body>
      <button>Native</button><div role="switch" aria-label="Explicit"></div>
      <div class="bnCheck" onclick="void 0" aria-label="Inferred"><span class="bnCheck-status"></span></div>
      <div onclick="void 0" aria-label="Click only">Click only</div>
      <button>Overlay</button>
    </body>`, { url: "https://x/", pretendToBeVisual: true, runScripts: "outside-only" });
    const win = dom.window as any;
    for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location"]) {
      vi.stubGlobal(name, name === "window" ? win : win[name]);
    }
    vi.stubGlobal("getComputedStyle", win.getComputedStyle.bind(win));
    vi.stubGlobal("CSS", { escape: (v: string) => v });
    win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
    Object.defineProperty(win.document, "elementFromPoint", { value: () => null });
    stubDocumentChrome([{ frameId: 0, parentFrameId: -1, dom }]);
    const debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tab: number, method: string) => {
        if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "ax", backendDOMNodeId: 123, role: { value: "button" }, name: { value: "AX overlay", sources: [{ attribute: "aria-label" }] } }] };
        if (method === "DOM.getDocument") {
          return { root: { children: [...win.document.querySelectorAll("[data-vtx-ax]")].map((el: any, index) => ({
            backendNodeId: el.textContent === "Overlay" ? 123 : 124 + index,
            attributes: Array.from(el.attributes as NamedNodeMap).flatMap(({ name, value }) => [name, value]),
          })) } };
        }
        return {};
      }),
    };
    const router = new ActionRouter();
    registerObserveHandlers(router, debuggerMgr as any);
    const response: any = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: { format }, requestId: "source", tabId: 42 });
    expect(response.error).toBeUndefined();
    const byName = (name: string) => response.result.elements.find((el: any) => el.name === name);
    expect(byName("Native")).toMatchObject({ role: "button", semanticSource: "dom", nameSource: "heuristic" });
    expect(byName("Explicit")).toMatchObject({ role: "switch", semanticSource: "dom", nameSource: "heuristic" });
    expect(byName("Inferred")).toMatchObject({ role: "checkbox", semanticSource: "heuristic" });
    expect(byName("Click only")).toMatchObject({ role: "div", semanticSource: "heuristic" });
    expect(byName("AX overlay")).toMatchObject({ role: "button", semanticSource: "ax", nameSource: "aria-label" });
    const withoutAX: any = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: { format, includeAX: false }, requestId: "no-ax", tabId: 42 });
    expect(withoutAX.error).toBeUndefined();
    expect(withoutAX.result.elements.find((el: any) => el.name === "Native")).toMatchObject({ role: "button", semanticSource: "dom" });
    expect(withoutAX.result.elements.find((el: any) => el.name === "Native").nameSource).toBeUndefined();
    expect(withoutAX.result.elements.find((el: any) => el.name === "Explicit").role).toBe("div");
  });

  it("marks AX only when its data is actually applied, including tree-toggle state and descriptions", () => {
    const elements: any[] = [
      { role: "button", name: "toggle", treeToggle: true, semanticSource: "heuristic" },
      { role: "div", name: "described", semanticSource: "heuristic" },
      { role: "div", name: "empty", semanticSource: "heuristic" },
    ];
    const nodes: any = new Map([
      [10, { nodeId: "a", role: { value: "img" }, properties: [{ name: "expanded", value: { value: true } }] }],
      [11, { nodeId: "b", role: { value: "generic" }, description: { value: "AX description" } }],
      [12, { nodeId: "c", role: { value: "generic" } }],
    ]);
    applyOverlay(elements, new Map([[0, 10], [1, 11], [2, 12]]), nodes, new Map());
    expect(elements[0]).toMatchObject({ role: "button", state: { expanded: true }, semanticSource: "ax" });
    expect(elements[1]).toMatchObject({ description: "AX description", semanticSource: "ax" });
    expect(elements[2].semanticSource).toBe("heuristic");
  });

  it("marks only resolved AX relations as contributions and ignores suppressed tree-toggle roles", () => {
    const elements: any[] = [
      { role: "div", name: "resolved", semanticSource: "heuristic" },
      { role: "div", name: "unresolved", semanticSource: "heuristic" },
      { role: "button", name: "toggle", treeToggle: true, semanticSource: "heuristic" },
    ];
    const nodes: any = new Map([
      [10, { nodeId: "a", role: { value: "generic" }, properties: [
        { name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 11 }] } },
        { name: "owns", value: { relatedNodes: [{ backendDOMNodeId: 11 }] } },
      ] }],
      [11, { nodeId: "b", role: { value: "generic" }, properties: [{ name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 99 }] } }] }],
      [12, { nodeId: "c", role: { value: "img" }, name: { value: "ignored" } }],
    ]);
    applyOverlay(elements, new Map([[0, 10], [1, 11], [2, 12]]), nodes, new Map());
    expect(elements[0]).toMatchObject({ controls: [{ index: 1 }], owns: [{ index: 1 }], semanticSource: "ax" });
    expect(elements[1].semanticSource).toBe("heuristic");
    expect(elements[2]).toMatchObject({ role: "button", name: "toggle", semanticSource: "heuristic" });
  });
});
