/**
 * hover-reveal page-side 模块契约测试。
 *
 * 背景：hover 隐藏元素（父级 :hover 才 display:block 的子控件）在 vortex 里
 * 既无法被 observe 发现，也无法被 act 直接点击（NOT_VISIBLE 超时）。
 * 本模块提供两个原语：
 *   - collectCandidates(selector, maxDepth)：目标元素的「可见且有盒」祖先候选（由近及远）
 *   - isVisible(selector)：目标当前是否可见
 *
 * 注：jsdom 无布局引擎，getBoundingClientRect 恒为 0，故测试里按 data-rect 打桩。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

function rectOf(el: Element): DOMRect {
  const raw = el.getAttribute("data-rect");
  if (!raw) return { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 } as DOMRect;
  const [x, y, w, h] = raw.split(",").map(Number);
  return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h } as DOMRect;
}

describe("hover-reveal page-side module", () => {
  beforeEach(() => {
    const dom = new JSDOM('<div id="host"></div>');
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    dom.window.Element.prototype.getBoundingClientRect = function () {
      return rectOf(this as Element);
    };
  });

  async function load() {
    vi.resetModules();
    await import("../src/page-side/hover-reveal.js");
    return (window as any).__vortexHoverReveal;
  }

  it("挂载 __vortexHoverReveal（version=1，含 collectCandidates/isVisible）", async () => {
    const ns = await load();
    expect(ns.version).toBe(1);
    expect(typeof ns.collectCandidates).toBe("function");
    expect(typeof ns.isVisible).toBe("function");
  });

  it("collectCandidates：返回由近及远的可见祖先，跳过隐藏/零尺寸祖先", async () => {
    const ns = await load();
    document.body.innerHTML = `
      <div id="row" data-rect="10,20,200,40">
        <div id="wrap" style="display:none" data-rect="10,20,200,40">
          <span id="ctl" style="display:none" data-rect="0,0,0,0"></span>
        </div>
      </div>`;

    const cands = ns.collectCandidates("#ctl", 6) as Array<{ id: string; tag: string; cls: string; text: string; depth: number; path: number[]; x: number; y: number; w: number; h: number }>;

    expect(cands.length).toBeGreaterThan(0);
    // 最近的那个可见祖先是 #row（#wrap 隐藏、#ctl 自身隐藏）
    expect(cands[0].id).toBe("row");
    // depth = 祖先层数：#wrap 是第 1 层但隐藏，#row 是第 2 层
    expect(cands[0].depth).toBe(2);
    // 不含隐藏祖先
    expect(cands.map((c) => c.id)).not.toContain("wrap");
    // 候选带可点的中心点
    expect(cands[0].w).toBe(200);
    expect(cands[0].h).toBe(40);
  });

  it("collectCandidates：目标本身可见时也只返回祖先（不含目标自身）", async () => {
    const ns = await load();
    document.body.innerHTML = `<div id="row" data-rect="0,0,100,30"><span id="ctl" data-rect="5,5,20,20"></span></div>`;
    const cands = ns.collectCandidates("#ctl", 6) as Array<{ id: string }>;
    expect(cands.map((c) => c.id)).toContain("row");
    expect(cands.map((c) => c.id)).not.toContain("ctl");
  });

  it("collectCandidates：目标不存在时返回空数组（不抛）", async () => {
    const ns = await load();
    expect(ns.collectCandidates("#nope", 6)).toEqual([]);
  });

  it("collectCandidates：非法选择器不抛，返回空数组", async () => {
    const ns = await load();
    expect(ns.collectCandidates(":::bad", 6)).toEqual([]);
  });

  it("isVisible：display:none 元素不可见，可见元素可见", async () => {
    const ns = await load();
    document.body.innerHTML = `<span id="hidden" style="display:none" data-rect="0,0,0,0"></span><span id="vis" data-rect="0,0,10,10"></span>`;
    expect(await ns.isVisible("#hidden")).toBe(false);
    expect(await ns.isVisible("#vis")).toBe(true);
  });

  it("isVisible：目标不存在 → false；非法选择器 → false（不抛）", async () => {
    const ns = await load();
    expect(await ns.isVisible("#nope")).toBe(false);
    expect(await ns.isVisible(":::bad")).toBe(false);
  });

  it("findRevealPairs：报出「hover 触发元素即显现」的隐藏控件", async () => {
    const ns = await load();
    document.head.innerHTML = `<style>
      .row:hover .ctl { display: block; }
      .ctl { cursor: pointer; }
      .row:hover { background: red; }
      .other:hover .ctl2 { display: none; }
    </style>`;
    document.body.innerHTML = `
      <div class="row" data-rect="0,0,200,40">Row label
        <span class="ctl" style="display:none" data-rect="0,0,0,0"></span>
      </div>
      <div class="other" data-rect="0,50,200,40">
        <span class="ctl2" style="display:none" data-rect="0,0,0,0"></span>
      </div>`;

    const pairs = ns.findRevealPairs(8) as Array<{
      triggerSelector: string;
      triggerText: string;
      controlSelector: string;
      controlTag: string;
    }>;

    expect(pairs.length).toBe(1);
    expect(pairs[0].triggerSelector).toBe(".row");
    expect(pairs[0].triggerText).toBe("Row label");
    expect(pairs[0].controlSelector).toContain(".ctl");
    expect(pairs[0].controlTag).toBe("span");
  });

  it("findRevealPairs：只报当前不可见的控件（可见的不报）", async () => {
    const ns = await load();
    document.head.innerHTML = `<style>.row:hover .ctl { display: block; }</style>`;
    document.body.innerHTML = `<div class="row" data-rect="0,0,200,40"><span class="ctl" data-rect="0,0,20,20"></span></div>`;

    expect(ns.findRevealPairs(8)).toEqual([]);
  });

  it("findRevealPairs：触发文本只取可见部分（跳过隐藏子树的文字）", async () => {
    const ns = await load();
    document.head.innerHTML = `<style>
      .row:hover .ctl { display: block; }
      .ctl { cursor: pointer; }
    </style>`;
    document.body.innerHTML = `
      <div class="row" data-rect="0,0,200,40">Row label
        <span style="display:none">HIDDEN-MENU</span>
        <span class="ctl" style="display:none" data-rect="0,0,0,0"></span>
      </div>`;

    const pairs = ns.findRevealPairs(8) as Array<{ triggerText: string }>;
    expect(pairs[0].triggerText).toBe("Row label");
    expect(pairs[0].triggerText).not.toContain("HIDDEN-MENU");
  });

  it("findRevealPairs：子代组合符规则（> i）也能解析出控件", async () => {
    const ns = await load();
    document.head.innerHTML = `<style>
      .row:hover > i { display: block; }
      i { cursor: pointer; }
    </style>`;
    document.body.innerHTML = `<div class="row" data-rect="0,0,200,40"><i style="display:none" data-rect="0,0,0,0"></i></div>`;

    const pairs = ns.findRevealPairs(8) as Array<{ controlSelector: string; controlTag: string }>;
    expect(pairs.length).toBe(1);
    expect(pairs[0].controlTag).toBe("i");
  });

  it("findRevealPairs：条数有上限（大量规则不致噪声爆炸）", async () => {
    const ns = await load();
    const css = Array.from({ length: 200 }, (_, i) => `.row${i}:hover .ctl${i} { display: block; }`).join("\n");
    document.head.innerHTML = `<style>${css}\n.ctl { cursor: pointer; }</style>`;
    document.body.innerHTML = Array.from(
      { length: 200 },
      (_, i) => `<div class="row${i}" data-rect="0,0,200,40"><span class="ctl${i}" style="display:none" data-rect="0,0,0,0"></span></div>`,
    ).join("");

    const pairs = ns.findRevealPairs(8) as unknown[];
    expect(pairs.length).toBeLessThanOrEqual(8);
  });

  it("findRevealPairs：无可交互控件时返回空（不报装饰元素）", async () => {
    const ns = await load();
    document.head.innerHTML = `<style>.row:hover .deco { display: block; }</style>`;
    document.body.innerHTML = `<div class="row" data-rect="0,0,200,40"><span class="deco" style="display:none" data-rect="0,0,0,0"></span></div>`;

    expect(ns.findRevealPairs(8)).toEqual([]);
  });

  it("findRevealPairs：无 cursor 但有 title 的控件也报（可点击但未设 cursor）", async () => {
    const ns = await load();
    document.head.innerHTML = `<style>.row:hover .ctl { display: block; }</style>`;
    document.body.innerHTML = `<div class="row" data-rect="0,0,200,40"><span class="ctl" title="新增" style="display:none" data-rect="0,0,0,0"></span></div>`;

    const pairs = ns.findRevealPairs(8) as Array<{ controlName: string }>;
    expect(pairs.length).toBe(1);
    expect(pairs[0].controlName).toBe("新增");
  });
});
