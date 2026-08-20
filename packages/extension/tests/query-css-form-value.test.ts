import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { elementsProbeFunc } from "../src/handlers/query.js";
import { shapeCssResult } from "../src/lib/element-shaping.js";

function queryCssResult(selector: string, attrs: string[], maxResults: number, includeText: boolean): unknown {
  return shapeCssResult(elementsProbeFunc(selector, maxResults, ["text", "attrs"], attrs, includeText) as never, {
    attributes: attrs,
    includeText,
  });
}

/**
 * vortex_query mode=css:form 控件 value/checked/selected 回退读 DOM property。
 *
 * 现象(log.bytenew.com dogfood 2026-07):mode=css attr=value 读日期/关键词 input 返空。
 *   input/textarea/select 的 value 是 live DOM property,用户输入/JS 赋值不反射为 HTML
 *   attribute → getAttribute("value") 常返 null → attrs 为空,agent 读不到实时值。
 * 修复:对 INPUT/TEXTAREA/SELECT/OPTION 的 value/checked/selected 优先读 property(布尔
 *   → "true"/"false"),回退 getAttribute;非 form 元素仍走 getAttribute(不回归)。
 */
describe("vortex_query mode=css form 控件 value 回退 property (@since 2026-07 log dogfood)", () => {
  beforeEach(() => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).NodeFilter = dom.window.NodeFilter;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).Element = dom.window.Element;
  });

  it("input 的 live .value(attribute 缺失)被读到", () => {
    document.body.innerHTML = '<input id="kw" type="text">';
    (document.getElementById("kw") as HTMLInputElement).value = "outputTokens"; // 仅 property,无 attribute
    expect(document.getElementById("kw")!.getAttribute("value")).toBeNull(); // 前提:attribute 确实为空
    const r = queryCssResult("input", ["value"], 5, false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs).toEqual({ value: "outputTokens" });
  });

  it("date input 的 property 值被读到(HH:mm/YYYY-MM-DD 同理)", () => {
    document.body.innerHTML = '<input id="d" type="date">';
    (document.getElementById("d") as HTMLInputElement).value = "2026-07-01";
    const r = queryCssResult("input", ["value"], 5, false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs?.value).toBe("2026-07-01");
  });

  it("空 input → value:\"\"(存在而非省略,反映真实空值)", () => {
    document.body.innerHTML = '<input id="e" type="text">';
    const r = queryCssResult("input", ["value"], 5, false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs).toEqual({ value: "" });
  });

  it("checkbox 的 checked property → \"true\"/\"false\"", () => {
    document.body.innerHTML = '<input id="c" type="checkbox">';
    (document.getElementById("c") as HTMLInputElement).checked = true; // property,无 checked attribute
    const r = queryCssResult("input", ["checked"], 5, false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs?.checked).toBe("true");
  });

  it("select 的 value → 选中 option 的值", () => {
    document.body.innerHTML =
      '<select id="s"><option value="a">A</option><option value="b" selected>B</option></select>';
    const r = queryCssResult("select", ["value"], 5, false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs?.value).toBe("b");
  });

  it("非 form 元素的 value attribute 仍走 getAttribute(不回归)", () => {
    document.body.innerHTML = '<li id="li" value="3">item</li>';
    const r = queryCssResult("li", ["value"], 5, false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs?.value).toBe("3");
  });
});
