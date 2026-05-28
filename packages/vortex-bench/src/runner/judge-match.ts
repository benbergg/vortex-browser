// packages/vortex-bench/src/runner/judge-match.ts
// 纯逻辑:LLM 判官输出 label 与 vortex observe 行 name 的对齐。
//
// 为什么用 label 而不是 bbox:多模态模型(Doubao / MiniMax / GLM 等)各家输出
// bbox 的坐标空间不同(归一化 0-1 / 0-1000 / 图片原像素 / CSS 像素),跨模型
// 不可移植;而 label 直接取 DOM 文字,跨模型稳定。代价是同页面重复 label 会
// collision,但 prompt 已要求判官只报 observe 列表里没列出的元素,实践中罕见。

/** 规范化 label 用于匹配:trim + 折叠内部空白 + lowercase(case-insensitive) */
export function normalizeLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 两个 label 规范化后是否相等(exact match) */
export function labelsMatch(a: string, b: string): boolean {
  return normalizeLabel(a) === normalizeLabel(b);
}
