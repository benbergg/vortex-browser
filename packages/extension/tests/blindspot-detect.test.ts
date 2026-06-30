// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectBlindspot, detectVirtualByScroll, detectDivVirtualScroller, detectChartCanvas, detectImageBlindspot } from "../src/page-side/blindspot-detect.js";

/** 清理 page-side 图表库全局,避免跨用例污染(Chart.js/G2 检测读 window 全局)。 */
function cleanupChartGlobals() {
  delete (window as any).Chart;
}

function withRect(el: Element, width: number, height: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height }),
    configurable: true,
  });
  return el as HTMLElement;
}

// jsdom 无布局:为 scroller 注入 scrollHeight/clientHeight,为子项注入等高 rect。
function makeDivScroller(opts: {
  scrollHeight: number;
  clientHeight: number;
  overflowY?: string;
  childCount: number;
  childHeight: number | number[];
}): HTMLElement {
  const sc = document.createElement("div");
  if (opts.overflowY) sc.style.overflowY = opts.overflowY;
  Object.defineProperty(sc, "scrollHeight", { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(sc, "clientHeight", { value: opts.clientHeight, configurable: true });
  const content = document.createElement("div");
  for (let i = 0; i < opts.childCount; i++) {
    const item = document.createElement("div");
    item.textContent = `Item #${i}`;
    const h = Array.isArray(opts.childHeight) ? opts.childHeight[i] : opts.childHeight;
    withRect(item, 300, h);
    content.appendChild(item);
  }
  sc.appendChild(content);
  document.body.appendChild(sc);
  return sc;
}

describe("detectBlindspot", () => {
  afterEach(cleanupChartGlobals);
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
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "screenshot" });
  });
  it("装饰性小 canvas(sparkline) → 不报（负例）", () => {
    document.body.innerHTML = `<canvas></canvas>`;
    const c = withRect(document.querySelector("canvas")!, 40, 16);
    expect(detectBlindspot(c, 0)).toBeNull();
  });
  it("zrender/echarts canvas → readback=chart", () => {
    const c = document.createElement("canvas");
    c.setAttribute("data-zr-dom-id", "zr_0");
    Object.defineProperty(c, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} }),
      configurable: true,
    });
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "chart", chartLib: "echarts" });
  });
  it("React fiber 祖先 canvas → readback=component", () => {
    const wrap = document.createElement("div");
    (wrap as any)["__reactFiber$abc123"] = {};
    const c = document.createElement("canvas");
    Object.defineProperty(c, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} }),
      configurable: true,
    });
    wrap.appendChild(c);
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "component" });
  });
  it("legacy React 祖先 canvas → readback=component", () => {
    const wrap = document.createElement("div");
    (wrap as any)["__reactInternalInstance$def456"] = {};
    const c = document.createElement("canvas");
    withRect(c, 400, 300);
    wrap.appendChild(c);
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "component" });
  });
  it("Vue 实例 canvas 自身 → readback=component", () => {
    const c = document.createElement("canvas");
    (c as any).__vue__ = {};
    Object.defineProperty(c, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} }),
      configurable: true,
    });
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "component" });
  });
  it("纯光栅 canvas(无框架/无图表) → readback=screenshot", () => {
    const c = document.createElement("canvas");
    Object.defineProperty(c, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} }),
      configurable: true,
    });
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "screenshot" });
  });
  it("Chart.js canvas(window.Chart.getChart 命中)→ readback=chart chartLib=chartjs", () => {
    const c = withRect(document.createElement("canvas"), 400, 300);
    (window as any).Chart = { getChart: (arg: any) => (arg === c ? { id: 0 } : undefined) };
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "chart", chartLib: "chartjs" });
  });
  it("G2 祖先(data-chart-source-type)canvas → readback=chart chartLib=g2plot", () => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-chart-source-type", "G2Plot");
    const c = withRect(document.createElement("canvas"), 400, 300);
    wrap.appendChild(c);
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "chart", chartLib: "g2plot" });
  });
  it("Chart.js canvas 在 React fiber 祖先内 → chart 优先于 component(锁顺序)", () => {
    const wrap = document.createElement("div");
    (wrap as any)["__reactFiber$xyz"] = {};
    const c = withRect(document.createElement("canvas"), 400, 300);
    wrap.appendChild(c);
    (window as any).Chart = { getChart: (arg: any) => (arg === c ? { id: 0 } : undefined) };
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "chart", chartLib: "chartjs" });
  });
  it("有 window.Chart 但 getChart 未命中本 canvas → 不算 chartjs(回落 screenshot)", () => {
    const c = withRect(document.createElement("canvas"), 400, 300);
    (window as any).Chart = { getChart: () => undefined };
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas", readback: "screenshot" });
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
  it("Naive 式虚拟表(有界视口 scrollH 48000/clientH 250/rowH 48,渲染12) → virtual ~1000 低置信", () => {
    // 有界专用滚动视口(isPageLevelScroller=false)。
    const b = detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 250 }, 12, 48, false);
    expect(b).toEqual({ kind: "virtual", total: 1000, rendered: 12, confidence: "low" });
  });
  it("普通可滚动列表(渲染100/estTotal≈100) → 不报（负例:渲染全部非虚拟）", () => {
    // sh=2000 ch=400 → 5x 强滚动,但 rendered=100 estTotal=100 不>>rendered
    expect(detectVirtualByScroll({ scrollHeight: 2000, clientHeight: 400 }, 100, 20, false)).toBeNull();
  });
  it("分页表(10 行无超额滚动 sh≈ch) → 不报（负例）", () => {
    expect(detectVirtualByScroll({ scrollHeight: 420, clientHeight: 400 }, 10, 40, false)).toBeNull();
  });
  it("行数太少(<3) → 不报（负例）", () => {
    expect(detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 250 }, 2, 48, false)).toBeNull();
  });
  it("clientHeight 0(未布局) → 不报（负例）", () => {
    expect(detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 0 }, 12, 48, false)).toBeNull();
  });
  it("强滚动但 estTotal 仅略多于渲染(rendered18/estTotal30) → 不报（负例:缓冲非虚拟）", () => {
    // sh=1200 ch=240 → 5x, rowH=40, estTotal=30, rendered=18 → 30<max(36,38) 不触发
    expect(detectVirtualByScroll({ scrollHeight: 1200, clientHeight: 240 }, 18, 40, false)).toBeNull();
  });
  it("全渲染文档表在页面级滚动容器(<main>)内 → 不报（负例:2026-06-22 react-aria FP）", () => {
    // react-aria DatePicker docs:props 表 37 行全渲染,滚动祖先是 <main>(scrollH 5967=整页内容、
    // ch 660)。est=5967/32≈186 看似虚拟,但页面级容器 scrollHeight 反映整页非该表 → 正确不报
    // (此前误报 ~186/37)。isPageLevelScroller=true。
    expect(detectVirtualByScroll({ scrollHeight: 5967, clientHeight: 660 }, 37, 32, true)).toBeNull();
  });
  it("页面级滚动容器即使强滚动+est远超渲染也不报（负例:页面级 scrollHeight 不可靠,A2-fb 不覆盖)", () => {
    // 即便数值满足虚拟判据,页面级容器(body/main/window-scroller)的 scrollH=整页 → est 不可信。
    // 此类 window-scroller 虚拟列表通常设 aria-rowcount,由 ARIA 路径覆盖,A2-fb 不冒误报风险。
    expect(detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 800 }, 12, 48, true)).toBeNull();
  });
  it("小列表嵌于高大导航祖先(scrollerRowCount 1249 >> rendered 6) → 不报（误报闸:MDN 实证）", () => {
    // aside scrollH=9692/clientH=634 → 15x 强滚动,rowH=32,est=303>>6 本会误报,
    // 但 scrollerRowCount=1249 > 6*2 → 祖先含其它内容,非本列表虚拟化 → null。
    expect(
      detectVirtualByScroll({ scrollHeight: 9692, clientHeight: 634 }, 6, 32, false, 1249),
    ).toBeNull();
  });
  it("真虚拟列表祖先只含窗口行(scrollerRowCount≈rendered) → 仍正常报", () => {
    // 显式传 scrollerRowCount=12(≈rendered 12,真虚拟:祖先只渲染窗口)→ 闸不触发,照常报。
    expect(detectVirtualByScroll({ scrollHeight: 48000, clientHeight: 250 }, 12, 48, false, 12)).toEqual({
      kind: "virtual",
      total: 1000,
      rendered: 12,
      confidence: "low",
    });
  });
});

describe("detectDivVirtualScroller (A2-fb-div 纯 div 虚拟列表)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  it("PrimeReact VirtualScroller 式(div容器+8等高div项/scrollH 5000000/clientH 198) → virtual ~100000 低置信", () => {
    const sc = makeDivScroller({ scrollHeight: 5000000, clientHeight: 198, overflowY: "auto", childCount: 8, childHeight: 50 });
    expect(detectDivVirtualScroller(sc)).toEqual({ kind: "virtual", total: 100000, rendered: 8, confidence: "low" });
  });
  it("非裁剪容器(overflowY visible 即便强滚动) → 不报（负例）", () => {
    const sc = makeDivScroller({ scrollHeight: 5000000, clientHeight: 198, overflowY: "visible", childCount: 8, childHeight: 50 });
    expect(detectDivVirtualScroller(sc)).toBeNull();
  });
  it("普通弱滚动 div 列表(scrollH 500/clientH 400,ratio<4) → 不报（负例:强滚动门）", () => {
    const sc = makeDivScroller({ scrollHeight: 500, clientHeight: 400, overflowY: "auto", childCount: 10, childHeight: 50 });
    expect(detectDivVirtualScroller(sc)).toBeNull();
  });
  it("全量渲染等高列表(50项全在DOM/scrollH 2500/clientH 400,estTotal≈渲染) → 不报（负例）", () => {
    // sh=2500 ch=400 → 6.25x 强滚动,但 50项全渲染,estTotal=50=rendered 不>>
    const sc = makeDivScroller({ scrollHeight: 2500, clientHeight: 400, overflowY: "auto", childCount: 50, childHeight: 50 });
    expect(detectDivVirtualScroller(sc)).toBeNull();
  });
  it("异构高度子项(非等高重复) → 不报（负例:非列表）", () => {
    const sc = makeDivScroller({ scrollHeight: 5000000, clientHeight: 198, overflowY: "auto", childCount: 8, childHeight: [50, 120, 30, 200, 80, 50, 300, 40] });
    expect(detectDivVirtualScroller(sc)).toBeNull();
  });
  it("变高虚拟列表(react-virtuoso 式 7 行 73~107px 成簇/scrollH 970000/clientH 590) → virtual ~10000 低置信", () => {
    // react-virtuoso 逐项测量行高不一(实测 100k-item demo 行高 73~107px,旧 ±2px 等高门只命中
    // 2 行 <3 → 整类漏报)。中位数 97,band[58.2,155.2] 全纳 7 行 → 触发。reactdatepicker/virtuoso.dev
    // 2026-06-23 dogfood R14 实证盲区。
    const sc = makeDivScroller({ scrollHeight: 970000, clientHeight: 590, overflowY: "auto", childCount: 7, childHeight: [73, 76, 89, 97, 103, 106, 107] });
    expect(detectDivVirtualScroller(sc)).toEqual({ kind: "virtual", total: 10000, rendered: 7, confidence: "low" });
  });
  it("子项过少(<3) → 不报（负例）", () => {
    const sc = makeDivScroller({ scrollHeight: 5000000, clientHeight: 198, overflowY: "scroll", childCount: 2, childHeight: 50 });
    expect(detectDivVirtualScroller(sc)).toBeNull();
  });
});

describe("detectChartCanvas", () => {
  afterEach(cleanupChartGlobals);
  it("zrender canvas(有 data-zr-dom-id)→ {chartLib:echarts}", () => {
    const c = document.createElement("canvas");
    c.setAttribute("data-zr-dom-id", "zr_0");
    expect(detectChartCanvas(c)).toEqual({ chartLib: "echarts" });
  });
  it("Chart.js canvas(window.Chart.getChart 命中)→ {chartLib:chartjs}", () => {
    const c = document.createElement("canvas");
    (window as any).Chart = { getChart: (arg: any) => (arg === c ? { id: 0 } : undefined) };
    expect(detectChartCanvas(c)).toEqual({ chartLib: "chartjs" });
  });
  it("G2 祖先(data-chart-source-type)canvas → {chartLib:g2plot}", () => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-chart-source-type", "G2Plot");
    const c = document.createElement("canvas");
    wrap.appendChild(c);
    expect(detectChartCanvas(c)).toEqual({ chartLib: "g2plot" });
  });
  it("无 data-zr-dom-id 的 canvas → null", () => {
    expect(detectChartCanvas(document.createElement("canvas"))).toBeNull();
  });
  it("非 canvas 元素(即便有 data-zr-dom-id)→ null", () => {
    const d = document.createElement("div");
    d.setAttribute("data-zr-dom-id", "zr_0");
    expect(detectChartCanvas(d)).toBeNull();
  });
});

describe("detectImageBlindspot", () => {
  function img(opts: { alt?: string | null; ariaLabel?: string; w?: number; h?: number; src?: string; ariaHidden?: boolean }) {
    const el = document.createElement("img");
    if (opts.alt != null) el.setAttribute("alt", opts.alt);
    if (opts.ariaLabel) el.setAttribute("aria-label", opts.ariaLabel);
    if (opts.ariaHidden) el.setAttribute("aria-hidden", "true");
    Object.defineProperty(el, "src", { value: opts.src ?? "https://x/p.jpg", configurable: true });
    withRect(el, opts.w ?? 320, opts.h ?? 240);
    return el;
  }
  it("无 alt 属性的内容图(够大)→ {src}", () => {
    expect(detectImageBlindspot(img({ src: "https://x/cat.jpg" }))).toEqual({ src: "https://x/cat.jpg" });
  });
  it("有意义 alt → null(可读)", () => {
    expect(detectImageBlindspot(img({ alt: "一只猫" }))).toBeNull();
  });
  it("alt=\"\" 显式装饰 → null(不报)", () => {
    expect(detectImageBlindspot(img({ alt: "" }))).toBeNull();
  });
  it("aria-label 提供文本 → null", () => {
    expect(detectImageBlindspot(img({ ariaLabel: "图标" }))).toBeNull();
  });
  it("aria-hidden 装饰 → null", () => {
    expect(detectImageBlindspot(img({ ariaHidden: true }))).toBeNull();
  });
  it("小图标(<80)→ null(排装饰/图标)", () => {
    expect(detectImageBlindspot(img({ w: 24, h: 24 }))).toBeNull();
  });
  it("非 img 元素 → null", () => {
    expect(detectImageBlindspot(withRect(document.createElement("div"), 320, 240))).toBeNull();
  });
});
