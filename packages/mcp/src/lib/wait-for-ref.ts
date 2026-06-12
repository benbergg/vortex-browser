/**
 * BUG-002 (N0063): wait_for(mode=element) 的 @ref 经 `value` 字段传入(其它 14 个工具走
 * `target`),不会命中 server.ts 的 target→{index,snapshotId,frameId} 翻译链,历史实现因此
 * 直接 throw "@ref form not supported here",破坏全程 ref 心智模型。
 *
 * 本 helper 在 server.ts target 翻译**之前**调用:把 @ref 形式的 value 抬成 target,复用同一
 * 条翻译 + STALE/tab 校验(dispatch 拿不到 activeSnapshot 状态无法自译,故必须在 server 层做)。
 * CSS selector 形式的 value(不以 @ 开头)保持不动,由 dispatch 的 element 分支按 selector 透传。
 */
export function liftWaitForRefToTarget(
  toolName: string,
  params: Record<string, unknown>,
): void {
  if (
    toolName === "vortex_wait_for" &&
    params.mode === "element" &&
    typeof params.value === "string" &&
    (params.value as string).startsWith("@")
  ) {
    params.target = params.value;
    delete params.value;
  }
}
