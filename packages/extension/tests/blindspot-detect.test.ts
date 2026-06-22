// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { detectBlindspot, detectVirtualByScroll } from "../src/page-side/blindspot-detect.js";

function withRect(el: Element, width: number, height: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height }),
    configurable: true,
  });
  return el as HTMLElement;
}

describe("detectBlindspot", () => {
  it("aria-rowcount 远大于渲染行 → virtual", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="1000">${"<div role='row'></div>".repeat(32)}</div>`;
    const grid = document.querySelector("[role=grid]")!;
    expect(detectBlindspot(grid as HTMLElement, 32)).toEqual({ kind: "virtual", total: 1000, rendered: 32 });
  });
  it("短列表 rowcount≈渲染 → 不报（负例）", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="5">${"<div role='row'></div>".repeat(5)}</div>`;
    expect(detectBlindspot(document.querySelector("[role=grid]") as HTMLElement, 5)).toBeNull();
  });
  it("listbox aria-setsize 远大于渲染 → virtual", () => {
    document.body.innerHTML = `<div role="listbox" aria-setsize="500"></div>`;
    expect(detectBlindspot(document.querySelector("[role=listbox]") as HTMLElement, 10)).toEqual({ kind: "virtual", total: 500, rendered: 10 });
  });
  it("大尺寸 canvas → canvas", () => {
    document.body.innerHTML = `<canvas></canvas>`;
    const c = withRect(document.querySelector("canvas")!, 800, 600);
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas" });
  });
  it("装饰性小 canvas(sparkline) → 不报（负例）", () => {
    document.body.innerHTML = `<canvas></canvas>`;
    const c = withRect(document.querySelector("canvas")!, 40, 16);
    expect(detectBlindspot(c, 0)).toBeNull();
  });
  it("自定义元素 closed shadow(无 shadowRoot,无 light 子) → shadow 低置信", () => {
    document.body.innerHTML = `<x-widget></x-widget>`;
    const w = withRect(document.querySelector("x-widget")!, 200, 80);
    expect(detectBlindspot(w, 0)).toEqual({ kind: "shadow", confidence: "low" });
  });
  it("自定义元素 open shadow → 不报（负例,shadowRoot 是对象,querySelectorAllDeep 已穿）", () => {
    document.body.innerHTML = `<x-open></x-open>`;
    const w = withRect(document.querySelector("x-open")!, 200, 80);
    w.attachShadow({ mode: "open" }).innerHTML = "<button>x</button>";
    expect(detectBlindspot(w, 0)).toBeNull();
  });
  it("自定义元素有 light-DOM 子 → 不报（负例）", () => {
    document.body.innerHTML = `<x-widget><span>hi</span></x-widget>`;
    const w = withRect(document.querySelector("x-widget")!, 200, 80);
    expect(detectBlindspot(w, 0)).toBeNull();
  });
  it("普通 div → 不报（负例）", () => {
    document.body.innerHTML = `<div>hi</div>`;
    expect(detectBlindspot(withRect(document.querySelector("div")!, 100, 40), 0)).toBeNull();
  });
});

describe("detectVirtualByScroll (A2-fb 非 ARIA 虚拟化)", () => {
  it("Naive 式虚拟表(渲染12/scrollH 48000/clientH 250/rowH 48) → virtual ~1000 低置信", () => {
    const b = detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 250 }, 12, 48);
    expect(b).toEqual({ kind: "virtual", total: 1000, rendered: 12, confidence: "low" });
  });
  it("普通可滚动列表(渲染100/estTotal≈100) → 不报（负例:渲染全部非虚拟）", () => {
    // sh=2000 ch=400 → 5x 强滚动,但 rendered=100 estTotal=100 不>>rendered
    expect(detectVirtualByScroll({ scrollHeight: 2000, clientHeight: 400 }, 100, 20)).toBeNull();
  });
  it("分页表(10 行无超额滚动 sh≈ch) → 不报（负例）", () => {
    expect(detectVirtualByScroll({ scrollHeight: 420, clientHeight: 400 }, 10, 40)).toBeNull();
  });
  it("行数太少(<3) → 不报（负例）", () => {
    expect(detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 250 }, 2, 48)).toBeNull();
  });
  it("clientHeight 0(未布局) → 不报（负例）", () => {
    expect(detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 0 }, 12, 48)).toBeNull();
  });
  it("强滚动但 estTotal 仅略多于渲染(rendered18/estTotal30) → 不报（负例:缓冲非虚拟）", () => {
    // sh=1200 ch=240 → 5x, rowH=40, estTotal=30, rendered=18 → 30<max(36,38) 不触发
    expect(detectVirtualByScroll({ scrollHeight: 1200, clientHeight: 240 }, 18, 40)).toBeNull();
  });
  it("小列表嵌于高大导航祖先(scrollerRowCount 1249 >> rendered 6) → 不报（误报闸:MDN 实证）", () => {
    // aside scrollH=9692/clientH=634 → 15x 强滚动,rowH=32,est=303>>6 本会误报,
    // 但 scrollerRowCount=1249 > 6*2 → 祖先含其它内容,非本列表虚拟化 → null。
    expect(
      detectVirtualByScroll({ scrollHeight: 9692, clientHeight: 634 }, 6, 32, 1249),
    ).toBeNull();
  });
  it("真虚拟列表祖先只含窗口行(scrollerRowCount≈rendered) → 仍正常报", () => {
    // 显式传 scrollerRowCount=12(≈rendered 12,真虚拟:祖先只渲染窗口)→ 闸不触发,照常报。
    expect(detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 250 }, 12, 48, 12)).toEqual({
      kind: "virtual",
      total: 1000,
      rendered: 12,
      confidence: "low",
    });
  });
});
