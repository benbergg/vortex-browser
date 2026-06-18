import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { normName, matchByDescriptor } from "../src/page-side/heal-resolve.js";

// jsdom 环境初始化：将 document/Element 绑到 globalThis，供 el() 辅助函数使用
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

describe("normName", () => {
  it("折叠空白并 trim", () => {
    expect(normName("  Save   Draft \n")).toBe("Save Draft");
    expect(normName(null)).toBe("");
  });
  it("undefined 返回空串", () => {
    expect(normName(undefined)).toBe("");
  });
});

describe("matchByDescriptor", () => {
  it("唯一命中（可见文本）", () => {
    const a = el(`<button>Submit</button>`);
    const b = el(`<button>Cancel</button>`);
    const r = matchByDescriptor([a, b], { role: "button", name: "Submit" });
    expect(r).toEqual({ kind: "unique", el: a });
  });

  it("唯一命中（aria-label）", () => {
    const a = el(`<button aria-label="Close dialog"></button>`);
    const r = matchByDescriptor([a], { role: "button", name: "Close dialog" });
    expect(r).toEqual({ kind: "unique", el: a });
  });

  it("name 归一化匹配（多空白）", () => {
    const a = el(`<a>Add   to\ncart</a>`);
    expect(matchByDescriptor([a], { name: "Add to cart" }).kind).toBe("unique");
  });

  it("多命中同名 → ambiguous（不静默错选）", () => {
    const a = el(`<button>Delete</button>`);
    const b = el(`<button>Delete</button>`);
    expect(matchByDescriptor([a, b], { role: "button", name: "Delete" }).kind).toBe("ambiguous");
  });

  it("role 软过滤可消歧", () => {
    const link = el(`<a>Open</a>`);
    const btn = el(`<button>Open</button>`);
    const r = matchByDescriptor([link, btn], { role: "button", name: "Open" });
    expect(r).toEqual({ kind: "unique", el: btn });
  });

  it("role 软过滤无法消歧时仍返回 ambiguous（不静默降级）", () => {
    // 两个 button 同名，desc.role="link" → roleMatches(button,"link") 全 false
    // → narrowed.length===0 → 不缩窄 → hits 保留 2 个 → ambiguous
    const a = el(`<button>Delete</button>`);
    const b = el(`<button>Delete</button>`);
    const r = matchByDescriptor([a, b], { role: "link", name: "Delete" });
    expect(r.kind).toBe("ambiguous");
  });

  it("无命中 → none", () => {
    const a = el(`<button>Submit</button>`);
    expect(matchByDescriptor([a], { name: "Nonexistent" }).kind).toBe("none");
  });

  it("空 name 永不命中（防退化全选）", () => {
    const a = el(`<button></button>`);
    expect(matchByDescriptor([a], { name: "" }).kind).toBe("none");
  });
});

describe("与 observe name 来源对齐", () => {
  it("可见文本元素：observe name 即 textContent，匹配器命中", () => {
    const a = el(`<button>Save Draft</button>`);
    const observeName = normName(a.textContent); // observe getAccessibleName 对纯文本走 textContent
    expect(matchByDescriptor([a], { role: "button", name: observeName }).kind).toBe("unique");
  });
  it("aria-label 元素：observe name 即 aria-label，匹配器命中", () => {
    const a = el(`<button aria-label="Close"></button>`);
    expect(matchByDescriptor([a], { role: "button", name: "Close" }).kind).toBe("unique");
  });
});

// label[for] 和 aria-labelledby 的测试需要元素挂到同一 document，
// 这样 document.querySelector/getElementById 才能跨元素解析。
// 使用带 url 的独立 JSDOM 实例避免 opaque origin 的 localStorage 限制。
describe("label/labelledby 名来源（I1）", () => {
  /** 创建带 url 的 JSDOM 实例并将给定 HTML 挂入 body，返回 document 与清理函数。 */
  function makeDoc(html: string): { doc: Document; cleanup: () => void } {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
      url: "http://localhost",
    });
    const doc = dom.window.document;
    // 覆盖 globalThis.document 使 matchByDescriptor 内部的 document.querySelector 用此 doc
    const prev = (globalThis as any).document;
    (globalThis as any).document = doc;
    return { doc, cleanup: () => { (globalThis as any).document = prev; } };
  }

  it("label[for] 命名 input：desc name='Email' → 命中该 input", () => {
    const { doc, cleanup } = makeDoc(
      `<label for="email-input">Email</label><input id="email-input" type="text">`,
    );
    try {
      const input = doc.querySelector("input")!;
      const r = matchByDescriptor([input], { role: "textbox", name: "Email" });
      expect(r).toEqual({ kind: "unique", el: input });
    } finally {
      cleanup();
    }
  });

  it("label[for] 命名 select：desc name='Country' → 命中该 select", () => {
    const { doc, cleanup } = makeDoc(
      `<label for="country-sel">Country</label><select id="country-sel"><option>US</option></select>`,
    );
    try {
      const select = doc.querySelector("select")!;
      const r = matchByDescriptor([select], { role: "combobox", name: "Country" });
      expect(r).toEqual({ kind: "unique", el: select });
    } finally {
      cleanup();
    }
  });

  it("aria-labelledby 命名 select：desc name='Country' → 命中该 select", () => {
    const { doc, cleanup } = makeDoc(
      `<span id="country-lbl">Country</span><select aria-labelledby="country-lbl"><option>US</option></select>`,
    );
    try {
      const select = doc.querySelector("select")!;
      const r = matchByDescriptor([select], { role: "combobox", name: "Country" });
      expect(r).toEqual({ kind: "unique", el: select });
    } finally {
      cleanup();
    }
  });

  it("aria-labelledby 命名 input（多 IDREF）：拼接文本 → 命中该 input", () => {
    const { doc, cleanup } = makeDoc(
      `<span id="fn">First</span><span id="ln">Last</span><input aria-labelledby="fn ln" type="text">`,
    );
    try {
      const input = doc.querySelector("input")!;
      const r = matchByDescriptor([input], { role: "textbox", name: "First Last" });
      expect(r).toEqual({ kind: "unique", el: input });
    } finally {
      cleanup();
    }
  });

  it("包裹 label 命名 checkbox：desc name='Remember me' → 命中该 input", () => {
    const { doc, cleanup } = makeDoc(
      `<label><input type="checkbox">Remember me</label>`,
    );
    try {
      const input = doc.querySelector("input")!;
      const labelText = normName(doc.querySelector("label")!.textContent);
      const r = matchByDescriptor([input], { name: labelText });
      expect(r).toEqual({ kind: "unique", el: input });
    } finally {
      cleanup();
    }
  });

  it("select 不使用 textContent（option 噪声）：无 label 时 → none", () => {
    // select 的 textContent 是全部 option 拼接，不应作为 name 匹配
    const select = el(`<select><option>Choice A</option><option>Choice B</option></select>`);
    // 若用 textContent 则会命中"Choice AChoice B"，但 observe 不会存这个名
    const r = matchByDescriptor([select], { role: "combobox", name: "Choice AChoice B" });
    expect(r.kind).toBe("none");
  });
});
