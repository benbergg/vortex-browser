// 维度名单一真源,避免 host 与探针各写一套而漂移。

const STYLE_GROUPS = ["typography", "box", "paint", "motion", "pseudo", "font"] as const;

// 老 mode=style 无条件返回这批扁平字段;拆成独立维度才能在 mode=elements 里单点请求,
// 也才能让只要 box 的调用跳过上溯 painted background 那趟祖先遍历。
export const CONTRAST_KEYS: readonly string[] = [
  "color", "background", "backgroundImage", "bgFromAncestor", "fontWeight", "fontSize",
  "contrastRatio", "contrastStatus", "wcagAA", "wcagAAA",
];

export const ALL_DIMENSIONS: readonly string[] = [
  "geometry", "text", "attrs", "contrast", ...STYLE_GROUPS,
];

// 逗号或竖线分隔,全空白视为未传。
export function normalizeDimensions(input: string | string[] | undefined): string[] | null {
  if (input == null) return null;
  const raw = Array.isArray(input) ? input : input.split(/[,|]/);
  const out = raw.map((d) => d.trim()).filter(Boolean);
  return out.length > 0 ? out : null;
}

export function dimensionsForMode(
  mode: "css" | "geometry" | "style",
  styleGroups: string[] | null,
): string[] {
  if (mode === "css") return ["text", "attrs"];
  if (mode === "geometry") return ["geometry"];
  // contrast 恒开:老 style 契约里这批字段与 groups 无关,少给就是行为变更
  return ["contrast", ...(styleGroups ?? STYLE_GROUPS)];
}
