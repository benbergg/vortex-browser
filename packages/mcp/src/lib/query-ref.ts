/**
 * vortex_query 的 pattern 在选择器类 mode 下就是元素定位符，却是唯一没接进
 * server.ts target→{index,snapshotId,frameId} 翻译链的入口（wait-for-ref.ts
 * 头注释里的 N0063 是同一类缺陷）。本 helper 在 target 翻译之前把 @ref 形态
 * 的 pattern 抬成 target，复用同一条翻译 + STALE/tab 校验。
 */
const QUERY_SELECTOR_MODES = new Set(["css", "component", "geometry", "style"]);

export function liftQueryRefToTarget(
  toolName: string,
  params: Record<string, unknown>,
): void {
  if (toolName !== "vortex_query") return;
  if (!QUERY_SELECTOR_MODES.has(params.mode as string)) return;
  // 已显式带 target 时不抢,避免悄悄吞掉调用方的定位意图
  if (params.target != null) return;
  const pattern = params.pattern;
  if (typeof pattern !== "string" || !pattern.startsWith("@")) return;
  params.target = pattern;
  delete params.pattern;
}
