// 维度名单一真源,避免 host 与探针各写一套而漂移。

const STYLE_GROUPS = ["typography", "box", "paint", "motion", "pseudo", "font"] as const;

export const ALL_DIMENSIONS: readonly string[] = ["geometry", "text", "attrs", ...STYLE_GROUPS];

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
  return styleGroups ?? [...STYLE_GROUPS];
}
