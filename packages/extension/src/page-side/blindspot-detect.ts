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
    return r.width * r.height >= CANVAS_MIN_AREA ? { kind: "canvas" } : null;
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
  // 滚动祖先 DOM 内实际行数(li/tr/role=row)。默认等于 renderedRows(向后兼容:
  // 不传时视为「祖先只含本列表」,闸不触发)。调用方应传真实测量值。
  scrollerRowCount: number = renderedRows,
): Blindspot | null {
  if (renderedRows < 3 || rowHeight < 4) return null;
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
