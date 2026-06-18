import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { __healInlineBody } from "../src/action/heal.js";
import { matchByDescriptor } from "../src/page-side/heal-resolve.js";

// 用 new Function 剥离模块闭包，复刻 executeScript 注入语义。
const inlineMatch = new Function(
  "candidates", "desc",
  `${__healInlineBody}; return __inlineMatch(candidates, desc);`,
) as (c: Element[], d: { role?: string; name: string }) => { kind: string };

describe("内联 heal 匹配体 ↔ heal-resolve 真源对齐", () => {
  // jsdom 初始化移入 beforeEach，避免 vitest 并行 worker 跨文件污染 globalThis。
  beforeEach(() => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    (globalThis as any).document = dom.window.document;
    (globalThis as any).Element = dom.window.Element;
  });

  function el(html: string): Element {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild!;
  }

  it("唯一文本: 两实现同 kind", () => {
    const cand = [el(`<button>Submit</button>`), el(`<button>Cancel</button>`)];
    const desc = { role: "button", name: "Submit" };
    expect(inlineMatch(cand, desc).kind).toBe(matchByDescriptor(cand, desc).kind);
  });

  it("aria-label: 两实现同 kind", () => {
    const cand = [el(`<button aria-label="Close"></button>`)];
    const desc = { role: "button", name: "Close" };
    expect(inlineMatch(cand, desc).kind).toBe(matchByDescriptor(cand, desc).kind);
  });

  it("歧义: 两实现同 kind", () => {
    const cand = [el(`<button>Del</button>`), el(`<button>Del</button>`)];
    const desc = { name: "Del" };
    expect(inlineMatch(cand, desc).kind).toBe(matchByDescriptor(cand, desc).kind);
  });

  it("无命中: 两实现同 kind", () => {
    const cand = [el(`<button>X</button>`)];
    const desc = { name: "Y" };
    expect(inlineMatch(cand, desc).kind).toBe(matchByDescriptor(cand, desc).kind);
  });

  it("空 name: 两实现同 kind", () => {
    const cand = [el(`<button></button>`)];
    const desc = { name: "" };
    expect(inlineMatch(cand, desc).kind).toBe(matchByDescriptor(cand, desc).kind);
  });

  // role-narrowing 分支：hits.length>1 且 desc.role 存在时，两实现均须 narrow 到同 kind。
  // 防止只改 TAG_ROLE_MAP 一处导致 inline↔真源漂移。
  it("role-narrowing 消歧: 两实现同 kind", () => {
    const link = el(`<a>Open</a>`);
    const btn = el(`<button>Open</button>`);
    // desc.role="button" 应过滤掉 <a>，令 button 唯一命中 → kind="unique"
    const desc = { role: "button", name: "Open" };
    expect(inlineMatch([link, btn], desc).kind).toBe(matchByDescriptor([link, btn], desc).kind);
  });

  // I1 新增：label[for] 与 aria-labelledby 对齐 case
  // label[for]/getElementById 需元素挂到同一 document（带 url 避免 opaque origin 限制）。
  function makeDoc(html: string): { doc: Document; cleanup: () => void } {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
      url: "http://localhost",
    });
    const doc = dom.window.document;
    const prev = (globalThis as any).document;
    (globalThis as any).document = doc;
    return { doc, cleanup: () => { (globalThis as any).document = prev; } };
  }

  it("label[for] 命名 input: 两实现同 kind", () => {
    const { doc, cleanup } = makeDoc(
      `<label for="x-inline">Email</label><input id="x-inline" type="text">`,
    );
    try {
      const input = doc.querySelector("input")!;
      const desc = { role: "textbox", name: "Email" };
      expect(inlineMatch([input], desc).kind).toBe(matchByDescriptor([input], desc).kind);
    } finally {
      cleanup();
    }
  });

  it("aria-labelledby 命名 select: 两实现同 kind", () => {
    const { doc, cleanup } = makeDoc(
      `<span id="clbl-inline">Country</span><select aria-labelledby="clbl-inline"><option>US</option></select>`,
    );
    try {
      const select = doc.querySelector("select")!;
      const desc = { role: "combobox", name: "Country" };
      expect(inlineMatch([select], desc).kind).toBe(matchByDescriptor([select], desc).kind);
    } finally {
      cleanup();
    }
  });

  // ShadowRoot aria-labelledby 对齐：root.getElementById 路径（ShadowRoot 有 getElementById）
  // 两实现须走同一路径（typeof root.getElementById==="function" → true → 直接调用）。
  it("ShadowRoot 内 aria-labelledby: 两实现同 kind", () => {
    const { doc, cleanup } = makeDoc("");
    try {
      // 构建 shadow host 并注入 shadow tree
      const host = doc.createElement("div");
      doc.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<span id="sh-lbl">Shadow Label</span><input aria-labelledby="sh-lbl" type="text">`;
      const input = shadow.querySelector("input")!;
      const desc = { role: "textbox", name: "Shadow Label" };
      // 两实现均须通过 root.getElementById("sh-lbl") 命中 shadow 内 span
      expect(inlineMatch([input], desc).kind).toBe(matchByDescriptor([input], desc).kind);
    } finally {
      cleanup();
    }
  });

  it("select 不使用 textContent: 两实现同 kind（均 none）", () => {
    const select = el(`<select><option>A</option><option>B</option></select>`);
    const desc = { role: "combobox", name: "AB" };
    expect(inlineMatch([select], desc).kind).toBe(matchByDescriptor([select], desc).kind);
  });
});
