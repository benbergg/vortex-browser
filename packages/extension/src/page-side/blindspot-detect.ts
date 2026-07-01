// packages/extension/src/page-side/blindspot-detect.ts
//
// observe 盲区降级信号检测。自包含纯函数:**不引模块级 helper**(page-side
// inline gotcha,见 memory vortex_page_side_func_inline_gotcha)。
// observe.ts 的 scan MAIN-world func 内联同一函数体(标记 [inline detectBlindspot]),
// 改一处须改两处;observe-blindspot-scan.test.ts 校验内联副本与本函数行为对齐。

export type Blindspot = {
  kind: "virtual" | "canvas" | "shadow";
  total?: number;
  rendered?: number;
  confidence?: "low";
  readback?: "component" | "screenshot" | "chart";
  chartLib?: string;
};

const VIRTUAL_ROLES = new Set(["grid", "treegrid", "table", "listbox", "tree"]);
// 排除装饰性 sparkline:仅当 canvas 足够大才算内容画布盲区。
const CANVAS_MIN_AREA = 200 * 150;

/**
 * 检测元素是否为盲区(observe 扫不全内部却不自知的容器)。
 * @param el 候选元素
 * @param renderedDescendants 该元素内已被 observe 收集/渲染的后代数(虚拟列表用渲染行数;其他用子元素数)
 * @returns 盲区信号或 null
 */
export function detectBlindspot(el: HTMLElement, renderedDescendants: number): Blindspot | null {
  const tag = el.tagName.toLowerCase();
  // A1 canvas:可交互内容画布,内部对象不在 DOM。
  if (tag === "canvas") {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < CANVAS_MIN_AREA) return null;
    // 图表库识别(廉价高精度,**优先于框架检测**:库 introspection 取精确数据系列,
    // 比 component-mode 读 state 更直达;避免把已知图表库 canvas 误标 screenshot/component。
    // Highcharts/D3 默认渲染 SVG(<text> 已被 observe 读),非 canvas 盲区,不在此列)。
    // ① echarts:zrender 给 canvas 打 data-zr-dom-id 属性。
    if (el.getAttribute("data-zr-dom-id") !== null) {
      return { kind: "canvas", readback: "chart", chartLib: "echarts" };
    }
    // ② G2/G2Plot(AntV):信号在祖先 div 的 data-chart-source-type(≤6 层)。
    for (let a: HTMLElement | null = el, i = 0; a && i < 6; i++, a = a.parentElement) {
      const cst = a.getAttribute("data-chart-source-type");
      if (cst) return { kind: "canvas", readback: "chart", chartLib: cst.toLowerCase() };
    }
    // ③ Chart.js:全局 Chart.getChart(canvas) 命中本 canvas 实例 → 数据在 chart.data。
    const __Cj = (window as any).Chart;
    if (__Cj && typeof __Cj.getChart === "function" && __Cj.getChart(el)) {
      return { kind: "canvas", readback: "chart", chartLib: "chartjs" };
    }
    // 框架驱动画布:canvas 或 ≤6 层祖先挂 React fiber / Vue 实例 → 状态可经
    // vortex_query mode=component 读回(Excalidraw 实证)。
    let node: HTMLElement | null = el;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      if ((node as any).__vue__ || (node as any).__vue_app__) return { kind: "canvas", readback: "component" };
      for (const k of Object.keys(node)) {
        if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) {
          return { kind: "canvas", readback: "component" };
        }
      }
    }
    return { kind: "canvas", readback: "screenshot" };
  }
  const role = (el.getAttribute("role") || "").toLowerCase();
  // A2 虚拟列表:ARIA 声明总量远大于渲染数。
  if (VIRTUAL_ROLES.has(role)) {
    const rc = parseInt(el.getAttribute("aria-rowcount") || "", 10);
    const ss = parseInt(el.getAttribute("aria-setsize") || "", 10);
    const declared = !isNaN(rc) && rc > 0 ? rc : !isNaN(ss) && ss > 0 ? ss : NaN;
    // 显著大于渲染(留缓冲,避免短列表/分页误报):至少多 2 倍或 +20。
    if (
      !isNaN(declared) &&
      declared > renderedDescendants &&
      declared >= Math.max(renderedDescendants * 2, renderedDescendants + 20)
    ) {
      return { kind: "virtual", total: declared, rendered: renderedDescendants };
    }
    return null;
  }
  // A2-fb 见下方 detectVirtualByScroll(非 ARIA 声明的虚拟化,由 dedicated pass 调用,不走此 per-element 路径)。
  // A3 closed-shadow best-effort:自定义元素(含连字符) + 有 layout box + 无可观察内部。
  // 判据用 DOM 内在量:`shadowRoot===null` 排除 open shadow(querySelectorAllDeep 已穿,
  // open 时 shadowRoot 是对象);`childElementCount===0` 排除有 light-DOM 子元素的。
  // 二者皆满足的自定义元素 = closed shadow 或空壳 → 低置信盲区。renderedDescendants 不参与。
  if (tag.includes("-") && el.shadowRoot === null && el.childElementCount === 0) {
    const r = el.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 24) return { kind: "shadow", confidence: "low" };
  }
  return null;
}

/**
 * A2-fb 非 ARIA 声明的虚拟列表检测(Semi/Naive/react-window/react-virtuoso 等不设 aria-rowcount)。
 * 核心判据:① 强滚动(scrollHeight ≥ clientHeight×4,普通滚动区/分页达不到) ② estTotal(scrollH/rowH)
 * 远大于渲染数(虚拟的本质=只渲染视口窗口;普通可滚动列表渲染全部 → estTotal≈rendered 不触发)。
 * 由 dedicated pass 提供已测量的 scroller + 渲染行数 + 行高(jsdom 无布局,measurements 由调用方/测试注入)。
 * confidence:low——是估算启发式,total 为近似值。
 */
export function detectVirtualByScroll(
  scroller: { scrollHeight: number; clientHeight: number },
  renderedRows: number,
  rowHeight: number,
  // 页面级滚动容器(body/html/main/scrollingElement 或近视口高):scrollHeight 反映整页非该列表,
  // estTotal 不可信 → 直接跳过(react-aria docs props 表 37 行全渲染却被误报 ~186/37,2026-06-22)。
  isPageLevelScroller: boolean,
  // 滚动祖先 DOM 内实际行数(li/tr/role=row)。默认等于 renderedRows(向后兼容:
  // 不传时视为「祖先只含本列表」,闸不触发)。调用方应传真实测量值。
  scrollerRowCount: number = renderedRows,
): Blindspot | null {
  if (renderedRows < 3 || rowHeight < 4) return null;
  // 页面级滚动容器(body/html/main/scrollingElement,或近视口高的整页滚动区)的 scrollHeight
  // 反映**整页内容**而非该列表——estTotal=scrollH/行高 会把整页高度误当列表行数,普通全渲染
  // 文档表被误报为虚拟列表(react-aria DatePicker docs 的 props 表 37 行全渲染,却因滚动祖先是
  // <main>(scrollH 5967=整页)被误报 virtual ~186/37,2026-06-22 dogfood)。本估算启发式只在
  // **有界专用滚动视口**(虚拟列表的常态:sizer 撑出 scrollHeight 的 overflow 容器)下可靠;
  // 页面级 window-scroller 虚拟列表通常设 aria-rowcount,由 ARIA 路径覆盖。
  if (isPageLevelScroller) return null;
  const sh = scroller.scrollHeight;
  const ch = scroller.clientHeight;
  if (ch <= 0 || sh < ch * 4) return null;
  // 误报闸(MDN CSS 参考侧栏实证):真虚拟列表的滚动祖先只含视口窗口的行
  // (scrollerRowCount ≈ renderedRows);若祖先 DOM 行数远多于本列表渲染数,说明
  // scrollHeight 来自祖先里**其它真实内容**(整片导航侧栏含多个列表共 1249 项),
  // estTotal=scrollH/rowH 把整片高度误当本列表的行 → 误报。某 6 项小列表的祖先
  // aside scrollH=9692/rowH=32 被估成 303,但 aside 实含 1249 项全在 DOM(非虚拟)。
  if (scrollerRowCount > renderedRows * 2) return null;
  const estTotal = Math.round(sh / rowHeight);
  if (estTotal > renderedRows && estTotal >= Math.max(renderedRows * 2, renderedRows + 20)) {
    return { kind: "virtual", total: estTotal, rendered: renderedRows, confidence: "low" };
  }
  return null;
}

/**
 * A2-fb-div 纯 div 虚拟列表检测(react-window/react-virtuoso/PrimeReact VirtualScroller 等:
 * 容器与行都是无 table/ul/[role] 语义的纯 div,detectVirtualByScroll 的语义候选/行选择器整类漏扫)。
 * 入参为疑似滚动容器。判据(与 detectVirtualByScroll 共享判定门,同 estTotal 公式):
 *  ① 强滚动:overflowY auto/scroll 且 scrollHeight ≥ clientHeight×4(普通内容达不到)
 *  ② 渲染窗口:内部存在某容器有 ≥3 个高度成簇的重复子项,且成簇占比 ≥70%(排除异构布局)
 *  ③ estTotal(scrollH/中位行高)远大于渲染数(虚拟本质=只渲染窗口;全量渲染列表 estTotal≈渲染 不触发)。
 * 廉价 scrollHeight 门先于 getComputedStyle,使可在全 div 上遍历调用而不爆开销。confidence:low。
 *
 * 高度成簇用「中位数 band」而非严格等高:react-virtuoso 等变高虚拟列表逐项测量,行高不一
 * (实测 100k-item demo 行高 73~107px,旧 ±2px 等高门只命中 2 行 <3 → 整类漏报)。
 * band=[median×0.6, median×1.6] 容纳中等变高行,又靠 ≥70% 占比把异构内容(行高跨度悬殊的
 * 非列表布局)挡在外面。等高列表方差为 0,median 即行高、band 全纳 → 与旧严格等高行为一致(无回归)。
 */
export function detectDivVirtualScroller(scroller: HTMLElement): Blindspot | null {
  const sh = scroller.scrollHeight;
  const ch = scroller.clientHeight;
  if (ch <= 0 || sh < ch * 4) return null; // 廉价强滚动门(先于 getComputedStyle)
  const oy = getComputedStyle(scroller).overflowY;
  if (oy !== "auto" && oy !== "scroll") return null; // 确认裁剪滚动(排除内容自然撑高不裁剪的)
  // 找渲染窗口:内部某 div 的直接子元素 ≥3 且高度成簇(中位数 band 内的重复行=列表特征)。
  let bestRows = 0;
  let bestRowH = 0;
  for (const w of Array.from(scroller.querySelectorAll("div"))) {
    const kids = Array.from(w.children);
    if (kids.length < 3) continue;
    const heights = kids.map((n) => n.getBoundingClientRect().height);
    const sorted = [...heights].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < 4) continue;
    const inBand = heights.filter((h) => h >= median * 0.6 && h <= median * 1.6).length;
    if (inBand >= 3 && inBand >= kids.length * 0.7 && inBand > bestRows) {
      bestRows = inBand;
      bestRowH = median;
    }
  }
  if (bestRows < 3) return null;
  const rendered = bestRows;
  const estTotal = Math.round(sh / bestRowH);
  if (estTotal > rendered && estTotal >= Math.max(rendered * 2, rendered + 20)) {
    return { kind: "virtual", total: estTotal, rendered, confidence: "low" };
  }
  return null;
}

/**
 * 图表 canvas 页级识别(charts-only 页级盲区扫描)。echarts/zrender 给其 canvas 打
 * data-zr-dom-id 属性(2026-06-30 真站 spike 验证)。非 canvas / 无该属性 → null。
 * observe.ts pageBlindspots pass 内联同一判定(标记 [inline detectChartCanvas]),
 * 改一处须改两处;observe-blindspot-scan.test.ts 校验。
 */
export function detectChartCanvas(el: HTMLElement): { chartLib: string } | null {
  if (el.tagName.toLowerCase() !== "canvas") return null;
  // ① echarts:zrender canvas 带 data-zr-dom-id。
  if (el.getAttribute("data-zr-dom-id") !== null) return { chartLib: "echarts" };
  // ② G2/G2Plot:祖先 div(≤6 层)data-chart-source-type。
  for (let a: HTMLElement | null = el, i = 0; a && i < 6; i++, a = a.parentElement) {
    const cst = a.getAttribute("data-chart-source-type");
    if (cst) return { chartLib: cst.toLowerCase() };
  }
  // ③ Chart.js:全局 Chart.getChart(canvas) 命中本 canvas。
  const Cj = (window as any).Chart;
  if (Cj && typeof Cj.getChart === "function" && Cj.getChart(el)) return { chartLib: "chartjs" };
  return null;
}

/**
 * 无 alt 内容图盲区识别(⑨ 实证:observe 对无 alt 图给空树,agent 须自己 query 发现)。
 * 内容图(够大)且无任何文本替代(alt/aria-label/title)→ 内容只在像素 → 指路 screenshot/src。
 * 排除:有意义 alt(可读)/ alt=""(显式装饰)/ aria-hidden / role=presentation / 图标级小图。
 * observe.ts pageBlindspots pass 内联同一判定(标记 [inline detectImageBlindspot]),改一处须改两处。
 */
export function detectImageBlindspot(el: HTMLElement): { src: string } | null {
  if (el.tagName.toLowerCase() !== "img") return null;
  const altVal = (el.getAttribute("alt") || "").trim();
  if (altVal) return null; // 有意义 alt → 可读,非盲区
  if (el.hasAttribute("alt")) return null; // alt="" 显式装饰 → 不报
  const aria = (el.getAttribute("aria-label") || "").trim();
  if (aria) return null;
  if ((el.getAttribute("title") || "").trim()) return null;
  if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("role") === "presentation") return null;
  const r = el.getBoundingClientRect();
  if (r.width < 80 || r.height < 80) return null; // 内容尺寸门(排图标/装饰)
  const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || el.getAttribute("src") || "";
  return { src: src.slice(0, 300) };
}

/** 空壳 SPA / 渲染失败 frame 级信号。@since blank-shell */
export type BlankShell = { root: string; rootLen: number; framework: string };

/**
 * 空壳 SPA / 渲染失败感知(P2 衍生:站点自身 JS/网络失败致 #root 空时 observe 静默空树,
 * 模型误读"无控件")。五门全满足才触发:framework 在场 + 根容器存在且近空 + 0 交互 +
 * document complete。软语义:加载中/真失败两态提示都正确。observe.ts page-side scan 内联
 * 同一判定(标记 [inline detectBlankShell]),改一处须改两处。win 传 window(单测传 mock)。
 * interactiveCount:调用方传"已排除结构性 html/body 的收集交互元素数"(某些站给 body 挂
 * cursor:pointer/listener 致其被收集,会击穿裸计数 —— g2.antv 空态实证)。
 */
export function detectBlankShell(doc: Document, win: any, interactiveCount: number): BlankShell | null {
  if (interactiveCount !== 0) return null;                       // ④ 有非结构性交互元素 → 非空壳
  if (doc.readyState !== "complete") return null;                // ⑤ 仍在加载 DOM 阶段
  let framework = "";                                            // ① framework 在场
  if (win.React !== undefined) framework = "react";
  else if (win.Vue !== undefined) framework = "vue";
  else if (win.__NEXT_DATA__ !== undefined) framework = "next";
  else if (typeof win.g_history !== "undefined" || win.g !== undefined) framework = "umi";
  else {
    for (const s of Array.from(doc.scripts)) {
      if (/(?:umi|react|vue|angular|svelte|next|nuxt)/i.test((s as HTMLScriptElement).src || "")) {
        framework = "script-chunk";
        break;
      }
    }
  }
  if (!framework) return null;
  for (const sel of ["#root", "#app", "#__next", "[data-reactroot]"]) {  // ② 挂载点 ③ 近空
    const el = doc.querySelector(sel);
    if (!el) continue;
    const len = el.innerHTML.trim().length;
    return len < 64 ? { root: sel, rootLen: len, framework } : null;      // 首个存在挂载点定状态
  }
  return null;
}
