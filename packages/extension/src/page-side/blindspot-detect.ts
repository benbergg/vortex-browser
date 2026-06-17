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
  // A3 closed-shadow best-effort:自定义元素(含连字符) + 有 layout box + 零可观察后代。
  // 收窄到自定义元素以压误报(closed shadow 仅存于自定义元素)。
  if (tag.includes("-") && renderedDescendants === 0) {
    const r = el.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 24) return { kind: "shadow", confidence: "low" };
  }
  return null;
}
