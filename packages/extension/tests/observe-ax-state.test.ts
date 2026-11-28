/**
 * R7: observe.snapshot 的 AX state 白名单补 focused / focusable / modal。
 *
 * 缺陷(2026-11-28 生产站复现):github.com/microsoft/vscode/issues 上点击
 * `input[placeholder="Search issues"]` 后,observe.snapshot 的 combobox state 只有
 * {autocomplete, haspopup, expanded};同一时刻 CDP AX 的 properties 给
 * focused:true/focusable:true。打开 GitHub「Quick search」对话框后,
 * `dialog "Quick search"` 的 state 为 null,而 AX 给 modal:true。
 * 归因:computeAXOverlay 的 state 白名单不含这三项(observe-ax-overlay.ts)。
 *
 * 语义规则:原始值严格等于布尔 true 才输出;缺失/false/"false"/其他非布尔一律不输出。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { computeAXOverlay } from "../src/handlers/observe-ax-overlay.js";
import type { CDPAXNode } from "../src/reasoning/types.js";

import { stubDocumentChrome } from "./helpers/document-chrome.js";
vi.mock("../src/handlers/observe-js-listener.js", () => ({ markListenerElements: vi.fn().mockResolvedValue({ mechanism: "domDebugger" }) }));

afterEach(() => vi.unstubAllGlobals());

const ax = (o: Partial<CDPAXNode>): CDPAXNode => ({ nodeId: "x", ...o });
const prop = (name: string, value: unknown) => ({ name, value: { value } });

describe("computeAXOverlay: focused / focusable / modal(R7)", () => {
  it("三项原值为布尔 true 时输出", () => {
    const node = ax({
      role: { value: "dialog" },
      properties: [prop("focused", true), prop("focusable", true), prop("modal", true)],
    });
    const r = computeAXOverlay({ backendId: 1, role: "div", name: "" }, node);
    expect(r.state?.focused).toBe(true);
    expect(r.state?.focusable).toBe(true);
    expect(r.state?.modal).toBe(true);
  });

  it.each([
    ["false", false],
    ["字符串 false", "false"],
    ["字符串 true", "true"],
    ["数字 1", 1],
    ["null", null],
    ["undefined", undefined],
  ])("focused 原值 %s 非严格布尔 true → 不输出", (_label, raw) => {
    const node = ax({ role: { value: "textbox" }, properties: [prop("focused", raw)] });
    const r = computeAXOverlay({ backendId: 2, role: "textbox", name: "" }, node);
    expect(r.state?.focused).toBeUndefined();
    expect(r.state ? "focused" in r.state : false).toBe(false);
  });

  it.each([
    ["false", false],
    ["字符串 false", "false"],
    ["字符串 true", "true"],
    ["数字 1", 1],
    ["null", null],
    ["undefined", undefined],
  ])("focusable 原值 %s 非严格布尔 true → 不输出", (_label, raw) => {
    const node = ax({ role: { value: "textbox" }, properties: [prop("focusable", raw)] });
    const r = computeAXOverlay({ backendId: 3, role: "textbox", name: "" }, node);
    expect(r.state?.focusable).toBeUndefined();
    expect(r.state ? "focusable" in r.state : false).toBe(false);
  });

  it.each([
    ["false", false],
    ["字符串 false", "false"],
    ["字符串 true", "true"],
    ["数字 1", 1],
    ["null", null],
    ["undefined", undefined],
  ])("modal 原值 %s 非严格布尔 true → 不输出", (_label, raw) => {
    const node = ax({ role: { value: "dialog" }, properties: [prop("modal", raw)] });
    const r = computeAXOverlay({ backendId: 4, role: "div", name: "" }, node);
    expect(r.state?.modal).toBeUndefined();
    expect(r.state ? "modal" in r.state : false).toBe(false);
  });

  it("AX 无这三项属性时 state 不出现对应键", () => {
    const node = ax({ role: { value: "button" }, name: { value: "普通按钮" } });
    const r = computeAXOverlay({ backendId: 5, role: "button", name: "普通按钮" }, node);
    expect(r.state).toBeUndefined();
  });

  it("旧键语义不变:expanded 保留显式 false,checked 支持 mixed", () => {
    const node = ax({
      role: { value: "checkbox" },
      properties: [prop("expanded", false), prop("checked", "mixed")],
    });
    const r = computeAXOverlay({ backendId: 6, role: "checkbox", name: "" }, node);
    expect(r.state?.expanded).toBe(false);
    expect(r.state?.checked).toBe("mixed");
  });

  it("旧键语义不变:autocomplete 保留合法 token,非法值丢弃", () => {
    const ok = ax({ role: { value: "combobox" }, properties: [prop("autocomplete", "list")] });
    expect(computeAXOverlay({ backendId: 7, role: "combobox", name: "" }, ok).state?.autocomplete).toBe("list");
    const bad = ax({ role: { value: "combobox" }, properties: [prop("autocomplete", "garbage")] });
    expect(computeAXOverlay({ backendId: 8, role: "combobox", name: "" }, bad).state?.autocomplete).toBeUndefined();
  });
});

/** 路由级:ActionRouter.dispatch + mock debugger。AX 树按 backendDOMNodeId 关联元素。 */
describe("observe.snapshot: AX 焦点/可聚焦/模态状态(R7)", () => {
  const BACKEND: Record<string, number> = { dlg: 301, first: 302, second: 303 };

  async function setup(axNodes: () => any[]) {
    const dom = new JSDOM(`<!doctype html><body>
      <div role="dialog" id="dlg" aria-label="Quick search">
        <input id="first" aria-label="Search or jump to" />
        <input id="second" aria-label="Other field" />
      </div>
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
        if (method === "Accessibility.getFullAXTree") return { nodes: axNodes() };
        if (method === "DOM.getDocument") {
          const marked = [...win.document.querySelectorAll("[data-vtx-ax]")] as any[];
          return {
            root: {
              backendNodeId: 1, nodeName: "HTML", attributes: [],
              children: [{
                backendNodeId: 1, nodeName: "BODY", attributes: [],
                children: marked.map((el) => ({
                  backendNodeId: BACKEND[el.id] ?? 900,
                  attributes: Array.from(el.attributes as NamedNodeMap).flatMap(({ name, value }) => [name, value]),
                })),
              }],
            },
          };
        }
        return {};
      }),
    };
    const router = new ActionRouter();
    registerObserveHandlers(router, debuggerMgr as any);
    const snapshot = async () => {
      const response: any = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: { format: "compact" }, requestId: "r", tabId: 42 });
      expect(response.error).toBeUndefined();
      return response.result.elements as any[];
    };
    return { snapshot, win };
  }

  it("元素 state 含 modal:true(dialog)/ focused:true / focusable:true", async () => {
    const { snapshot } = await setup(() => [
      { nodeId: "dlg", backendDOMNodeId: 301, role: { value: "dialog" }, name: { value: "Quick search" },
        properties: [prop("modal", true)] },
      { nodeId: "first", backendDOMNodeId: 302, role: { value: "combobox" }, name: { value: "Search or jump to" },
        properties: [prop("focused", true), prop("focusable", true)] },
      { nodeId: "second", backendDOMNodeId: 303, role: { value: "textbox" }, name: { value: "Other field" },
        properties: [prop("focusable", true)] },
    ]);
    const elements = await snapshot();
    const byName = (name: string) => {
      const el = elements.find((e) => e.name === name);
      expect(el, `元素 ${name} 未被收集`).toBeDefined();
      return el!;
    };
    expect(byName("Quick search").state?.modal).toBe(true);
    expect(byName("Search or jump to").state?.focused).toBe(true);
    expect(byName("Search or jump to").state?.focusable).toBe(true);
    expect(byName("Other field").state?.focusable).toBe(true);
    // 未获焦点的控件不得带 focused
    expect(byName("Other field").state?.focused).toBeUndefined();
    // 焦点控件不得带 modal
    expect(byName("Search or jump to").state?.modal).toBeUndefined();
  });

  it("焦点转移负例:新焦点元素 focused:true,旧元素不再输出 focused", async () => {
    let focusOn = "first";
    const { snapshot } = await setup(() => [
      { nodeId: "dlg", backendDOMNodeId: 301, role: { value: "dialog" }, name: { value: "Quick search" },
        properties: [prop("modal", true)] },
      { nodeId: "first", backendDOMNodeId: 302, role: { value: "combobox" }, name: { value: "Search or jump to" },
        properties: [prop("focused", focusOn === "first"), prop("focusable", true)] },
      { nodeId: "second", backendDOMNodeId: 303, role: { value: "textbox" }, name: { value: "Other field" },
        properties: [prop("focused", focusOn === "second"), prop("focusable", true)] },
    ]);

    const before = await snapshot();
    const beforeByName = (name: string) => {
      const el = before.find((e) => e.name === name);
      expect(el, `元素 ${name} 未被收集`).toBeDefined();
      return el!;
    };
    expect(beforeByName("Search or jump to").state?.focused).toBe(true);
    expect(beforeByName("Other field").state?.focused).toBeUndefined();

    focusOn = "second";
    const after = await snapshot();
    const afterByName = (name: string) => {
      const el = after.find((e) => e.name === name);
      expect(el, `元素 ${name} 未被收集`).toBeDefined();
      return el!;
    };
    // 元素身份保持不变(同一组元素、同一 ref/role)
    expect(after.map((el) => el.name).sort()).toEqual(before.map((el) => el.name).sort());
    expect(afterByName("Other field").state?.focused).toBe(true);
    expect(afterByName("Search or jump to").state?.focused).toBeUndefined();
    // modal 与 focusable 不受焦点转移影响
    expect(afterByName("Quick search").state?.modal).toBe(true);
    expect(afterByName("Search or jump to").state?.focusable).toBe(true);
  });

  it("负例:AX 无这三项属性时 state 不出现对应键", async () => {
    const { snapshot } = await setup(() => [
      { nodeId: "first", backendDOMNodeId: 302, role: { value: "combobox" }, name: { value: "Search or jump to" },
        properties: [prop("focused", false), prop("focusable", "false"), prop("modal", false)] },
    ]);
    const elements = await snapshot();
    const el = elements.find((e) => e.name === "Search or jump to");
    expect(el, "元素未被收集").toBeDefined();
    expect(el!.state?.focused).toBeUndefined();
    expect(el!.state?.focusable).toBeUndefined();
    expect(el!.state?.modal).toBeUndefined();
  });
});
