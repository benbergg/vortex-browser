import { QUERY_SELECTOR_MODES, VtxErrorCode, vtxError } from "@vortex-browser/shared";

/**
 * vortex_query 的 pattern 在选择器类 mode 下就是元素定位符，却是唯一没接进
 * server.ts target→{index,snapshotId,frameId} 翻译链的入口（wait-for-ref.ts
 * 头注释里的 N0063 是同一类缺陷）。本 helper 在 target 翻译之前把 @ref 形态
 * 的 pattern 抬成 target，复用同一条翻译 + STALE/tab 校验。
 *
 * vortex_query 的公开 schema 没有 target 字段。两者同时出现时直接拒绝，不能
 * 静默留两套定位参数：server 会把 target 译成 selector，extension 却因为
 * pattern 非空而用 pattern，调用方拿到的是它没要的那个元素（评审 Task 1 H-2）。
 */
export function liftQueryRefToTarget(
  toolName: string,
  params: Record<string, unknown>,
): void {
  if (toolName !== "vortex_query") return;
  if (!QUERY_SELECTOR_MODES.has(params.mode as string)) return;
  if (params.target != null && params.pattern != null) {
    throw vtxError(
      VtxErrorCode.INVALID_PARAMS,
      "vortex_query accepts `pattern` only (a CSS selector or an @ref); remove `target`",
    );
  }
  const pattern = params.pattern;
  if (typeof pattern !== "string" || !pattern.startsWith("@")) return;
  params.target = pattern;
  delete params.pattern;
}
