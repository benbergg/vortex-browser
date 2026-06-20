import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { textSearchFunc, cssQueryFunc } from "../src/handlers/query.js";

/**
 * vortex_query open shadow 穿透回归锁(白盒实机复现,2026-06-20)。
 *
 * 现象:cssQueryFunc 用 document.querySelectorAll、textSearchFunc 用
 *   createTreeWalker(document.body),两者都不下降 open shadow root。web-component
 *   页面上 shadow 内的元素/文本 → css total 漏计、text total:0,无 error 无信号
 *   (silent false-negative,agent 误读「不存在」)。sibling 感知原语 observe 用
 *   深度封顶 8 的 querySelectorAllDeep 穿 open shadow(98b61e5),两者 reach 不一致。
 *   live: example.com 注入 open-shadow host,observe 找到 2 button、query css 仅 1、
 *   text 命中 0。
 *
 * 修复:两模式都改深度遍历穿 open shadow(与 observe 同语义,SHADOW_WALK_MAX_DEPTH=8,
 *   closed shadow 的 shadowRoot 返 null 天然不穿)。textSearchFunc / cssQueryFunc 是
 *   注入 page-side 的函数,JSDOM 直接执行验证真实遍历行为(JSDOM 实现 open shadow DOM)。
 */
describe("vortex_query 穿 open shadow(@since 2026-06-20 白盒审计)", () => {
  beforeEach(() => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).NodeFilter = dom.window.NodeFilter;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).Element = dom.window.Element;
  });

  function mountShadowFixture(): void {
    document.body.innerHTML =
      '<button id="light-btn">Light Button</button><div id="host"></div><p>VISIBLE_LIGHT_TEXT</p>';
    const host = document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML =
      '<button id="shadow-btn">Shadow Button</button><span>SHADOW_UNIQUE_TEXT_42</span>';
  }

  it("css 模式:count 含 open shadow 内 button(light 1 + shadow 1 = 2)", () => {
    mountShadowFixture();
    const r = cssQueryFunc("button", null, 20, true) as {
      elements: Array<{ text?: string }>;
      total: number;
    };
    expect(r.total).toBe(2);
    const texts = r.elements.map((e) => e.text);
    expect(texts).toContain("Light Button");
    expect(texts).toContain("Shadow Button");
  });

  it("text 模式:grep 命中 open shadow 内文本", () => {
    mountShadowFixture();
    const r = textSearchFunc("SHADOW_UNIQUE_TEXT_42", false, false, 20, 10) as {
      matches: unknown[];
      total: number;
    };
    expect(r.total).toBe(1);
    expect(r.matches).toHaveLength(1);
  });

  it("text 模式:light-DOM 文本不回归(仍命中)", () => {
    mountShadowFixture();
    const r = textSearchFunc("VISIBLE_LIGHT_TEXT", false, false, 20, 10) as { total: number };
    expect(r.total).toBe(1);
  });

  it("css 模式:无 shadow 页面零漂移(light-DOM 计数不变)", () => {
    document.body.innerHTML = '<button>A</button><button>B</button><a href="#">L</a>';
    const r = cssQueryFunc("button", null, 20, true) as { total: number; elements: unknown[] };
    expect(r.total).toBe(2);
    expect(r.elements).toHaveLength(2);
  });

  it("css 模式:嵌套 open shadow 也穿(两层)", () => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById("outer")!;
    const sr1 = outer.attachShadow({ mode: "open" });
    sr1.innerHTML = '<div id="inner"></div>';
    const inner = sr1.getElementById("inner")!;
    const sr2 = inner.attachShadow({ mode: "open" });
    sr2.innerHTML = '<button>Deep Button</button>';
    const r = cssQueryFunc("button", null, 20, true) as {
      total: number;
      elements: Array<{ text?: string }>;
    };
    expect(r.total).toBe(1);
    expect(r.elements[0].text).toBe("Deep Button");
  });
});
