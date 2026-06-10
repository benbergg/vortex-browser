import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { hasOwnContentText, isClickableContentCard, isSelfClickable } from "../src/page-side/content-card.js";

function setupDom(html: string): Document {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document as unknown as Document;
  (globalThis as unknown as { Node: typeof Node }).Node = dom.window.Node;
  (globalThis as unknown as { NodeFilter: typeof NodeFilter }).NodeFilter = dom.window.NodeFilter;
  (globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle =
    dom.window.getComputedStyle.bind(dom.window);
  return dom.window.document;
}

describe("hasOwnContentText — 容器自有内容判定", () => {
  it("评价卡:正文在非交互 div.info,标签在 cursor:pointer 子 → true", () => {
    const doc = setupDom(
      `<li id="t"><div class="info">这是一条很长的真实评价正文内容</div>` +
      `<div class="term" style="cursor:pointer">拍照清晰</div></li>`,
    );
    expect(hasOwnContentText(doc.getElementById("t")!)).toBe(true);
  });

  it("商品卡:标题价格在非交互 span → true", () => {
    const doc = setupDom(
      `<div id="t"><span>Apple iPhone 16 128GB 白色</span><span>¥4172</span>` +
      `<button style="cursor:pointer">加入购物车</button></div>`,
    );
    expect(hasOwnContentText(doc.getElementById("t")!)).toBe(true);
  });

  it("SKU 容器:所有文本都在 cursor:pointer 子 → false", () => {
    const doc = setupDom(
      `<div id="t"><span style="cursor:pointer">粉色</span>` +
      `<span style="cursor:pointer">黑色</span>` +
      `<span style="cursor:pointer">128GB</span></div>`,
    );
    expect(hasOwnContentText(doc.getElementById("t")!)).toBe(false);
  });

  it("阈值:非可点文本不足 8 字符 → false", () => {
    const doc = setupDom(`<div id="t"><span>短</span></div>`);
    expect(hasOwnContentText(doc.getElementById("t")!)).toBe(false);
  });
});

/** 手挂 React fiber 模拟 __reactProps$.onClick(hasFrameworkClickHandler 检测的真信号)。 */
function attachReactClick(el: Element): void {
  (el as unknown as Record<string, unknown>)["__reactProps$test"] = { onClick: () => {} };
}

describe("isClickableContentCard — 真值表", () => {
  it("商品卡:onClick + 自有文本 → true", () => {
    const doc = setupDom(`<div id="t"><span>Apple iPhone 16 白色</span>` +
      `<button style="cursor:pointer">加入购物车</button></div>`);
    const el = doc.getElementById("t")!;
    attachReactClick(el);
    expect(isClickableContentCard(el)).toBe(true);
  });

  it("评价卡:onClick + 正文 + cursor:pointer 标签 → true", () => {
    const doc = setupDom(`<li id="t"><div class="info">很长的评价正文内容在此</div>` +
      `<div class="term" style="cursor:pointer">拍照清晰</div></li>`);
    const el = doc.getElementById("t")!;
    attachReactClick(el);
    expect(isClickableContentCard(el)).toBe(true);
  });

  it("SKU 容器:onClick(委托) + 文本全在可点子 → false", () => {
    const doc = setupDom(`<div id="t"><span style="cursor:pointer">粉色</span>` +
      `<span style="cursor:pointer">黑色</span></div>`);
    const el = doc.getElementById("t")!;
    attachReactClick(el);
    expect(isClickableContentCard(el)).toBe(false);
  });

  it("纯 wrapper:无 onClick → false", () => {
    const doc = setupDom(`<div id="t"><span>Apple iPhone 16 白色长文本</span></div>`);
    expect(isClickableContentCard(doc.getElementById("t")!)).toBe(false);
  });
});

describe("isSelfClickable — 自身独立可点", () => {
  it("cursor:pointer 无 fw → true", () => {
    const doc = setupDom(`<div id="t" style="cursor:pointer">商品卡片标题文本</div>`);
    expect(isSelfClickable(doc.getElementById("t")!)).toBe(true);
  });

  it("framework onClick 无 cursor:pointer → true", () => {
    const doc = setupDom(`<div id="t">框架卡片</div>`);
    const el = doc.getElementById("t")!;
    attachReactClick(el);
    expect(isSelfClickable(el)).toBe(true);
  });

  it("cursor:pointer + framework onClick(京东 _card)→ true", () => {
    const doc = setupDom(`<div id="t" style="cursor:pointer">Apple iPhone 16</div>`);
    const el = doc.getElementById("t")!;
    attachReactClick(el);
    expect(isSelfClickable(el)).toBe(true);
  });

  it("cursor:auto 无 fw(普通布局 wrapper)→ false", () => {
    const doc = setupDom(`<div id="t"><button style="cursor:pointer">提交</button></div>`);
    expect(isSelfClickable(doc.getElementById("t")!)).toBe(false);
  });
});
