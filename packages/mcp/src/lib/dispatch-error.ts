// 单工具路径与 vortex_sequence 共用的 dispatch 错误格式化。
// 抽出来是因为序列那份是残缺重写:只出 [code]: message,hint 全丢——
// 而 hint 正是调用方唯一能据以恢复的信息(2026-08-13 班牛真站 dogfood 实证)。
import { DEFAULT_ERROR_META, type VtxErrorCode } from "@vortex-browser/shared";

export interface DispatchErrorLike {
  code: string;
  message: string;
  hint?: string;
  context?: { extras?: unknown };
}

export function formatDispatchError(err: DispatchErrorLike): string {
  const code = err.code;
  // 三层兜底:remote hint > STALE_SNAPSHOT 中文兜底 > DEFAULT_ERROR_META。
  // 早期 handler / page-side throw 的 sentinel 字符串不带 hint,靠后两层补。
  let hintText = "";
  if (err.hint) {
    hintText = `\nHint: ${err.hint}`;
  } else if (code === "STALE_SNAPSHOT") {
    hintText = "\nHint: DOM 已变更，ref 失效。请重新调用 vortex_observe 获取新 snapshot。";
  } else {
    const meta = DEFAULT_ERROR_META[code as VtxErrorCode];
    if (meta?.hint) hintText = `\nHint: ${meta.hint}`;
  }
  // surface code 是 TIMEOUT 但根因是 ref detach 时,额外拼 NOT_ATTACHED 的 hint（P0-3）
  const lastReason = (err.context?.extras as { lastReason?: string } | undefined)?.lastReason;
  if (code === "TIMEOUT" && lastReason === "NOT_ATTACHED") {
    const notAttachedHint = DEFAULT_ERROR_META["NOT_ATTACHED" as VtxErrorCode]?.hint;
    if (notAttachedHint) hintText += `\nHint (lastReason=NOT_ATTACHED): ${notAttachedHint}`;
  }
  return `Error [${code}]: ${err.message}${hintText}`;
}
