// packages/vortex-bench/src/runner/judge-match.ts
// 纯逻辑:LLM 判官输出 label 与 vortex observe 行 name 的对齐。
//
// 为什么用 label 而不是 bbox 做主匹配:多模态模型(Doubao / MiniMax / GLM 等)各家
// 输出 bbox 的坐标空间不同(归一化 0-1 / 0-1000 / 图片原像素 / CSS 像素),跨模型
// 不可移植;而 label 直接取 DOM 文字,跨模型稳定。代价是同页面重复 label 会
// collision,但 prompt 已要求判官只报 observe 列表里没列出的元素,实践中罕见。
//
// 但 label-exact 在图文混排真站(京东 banner 文字印在图片像素里)对不上 observe 的
// DOM accessible name → 近 100% 假阳(2026-06-04 live 坐实)。故 live 路径再加一层
// bbox **兜底过滤**(reconcileByBbox):候选左上角落在某 observe ref bbox 内即丢弃。
// bbox 仅作"observe 在此位置有没有 ref"的几何核对,只减 FP、坐标系不符时退化 no-op,
// 不替代 label 主判定,规避了上面"bbox 不可移植"的风险。

/** 规范化 label 用于匹配:trim + 折叠内部空白 + lowercase(case-insensitive) */
export function normalizeLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 两个 label 规范化后是否相等(exact match) */
export function labelsMatch(a: string, b: string): boolean {
  return normalizeLabel(a) === normalizeLabel(b);
}

/** observe ref 的 bbox [x,y,w,h](含 margin 容差)是否覆盖点 (px,py)。 */
export function bboxCoversPoint(
  box: readonly [number, number, number, number],
  px: number,
  py: number,
  margin = 8,
): boolean {
  const [x, y, w, h] = box;
  return px >= x - margin && px <= x + w + margin && py >= y - margin && py <= y + h + margin;
}

/**
 * bbox 兜底过滤判官 recall-miss 假阳(2026-06-04 京东 live 评测坐实)。
 *
 * 判官按 prompt 里的 observe DOM 名列表对比报漏,但它读的是**截图像素文字**
 * (图片 banner 上印的 "手机直降"),与 observe 的 accessible name("大促",来自
 * `<a aria-label>`)对不上 → 报假漏,而 observe 在该位置其实有 ref。
 *
 * 用判官候选的**左上角** (bbox[0], bbox[1]) 判定:左上角在 [x,y,w,h] 与
 * [x1,y1,x2,y2] 两种格式下都是 (x,y),format-agnostic(实测 Doubao 被要求出
 * [x,y,w,h] 却出了 [x1,y1,x2,y2],左上角仍可靠)。落在任一 observe ref bbox
 * (含容差)内 → observe 已覆盖该位置 → 丢弃候选。
 *
 * **只减少 FP**:坐标系不符 / observe 无 bbox 时,点不落任何框,退化为原行为
 * (候选全保留),不会误删真漏。
 */
export function reconcileByBbox<T extends { bbox: readonly number[] }>(
  misses: T[],
  observeRows: { bbox: readonly [number, number, number, number] | null }[],
): T[] {
  const boxes = observeRows
    .map((r) => r.bbox)
    .filter((b): b is [number, number, number, number] => b != null);
  if (boxes.length === 0) return misses;
  return misses.filter(
    (m) => !boxes.some((b) => bboxCoversPoint(b, m.bbox[0], m.bbox[1])),
  );
}
