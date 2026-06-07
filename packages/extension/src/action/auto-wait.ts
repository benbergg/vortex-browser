// L2 Action - Auto-wait (RAF polling + reason-aware retry).
// Reference: design doc §5.3 + docs/spec-l2-action.md §2.
//
// Default timeout 5000ms; each reason has its own retry interval (per spec §2 table).
// On timeout exhaustion, throws vtxError(TIMEOUT) with extras.lastReason carrying the last failure code.

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";
import {
  checkActionability,
  type ActionabilityFailure,
  type ActionabilityResult,
  type CheckOptions,
} from "./actionability.js";

const DEFAULT_TIMEOUT_MS = 5000;

// 内层 actionability 等待必须严格小于 MCP 传输层硬超时(client.ts requestOnce,
// 默认 VORTEX_TIMEOUT_MS=30000ms)。调用方可经 act options.timeout 传任意大值且
// schema 无上界(schemas-public.ts),若不 cap,传输层会以微弱差距先放弃,真实门
// 失败原因(NOT_VISIBLE/OBSCURED…)到不了 caller,只剩误导的 "no response"。
// 25s 留 5s margin(同 navigate 的 NAVIGATE_LOAD_TIMEOUT_MS,2026-06-03 act 原语
// 白盒审计族 D;根因同 round16 navigate)。影响所有 gated 原语:click/fill/type/select。
const MAX_ACTIONABLE_TIMEOUT_MS = 25_000;

const RETRY_INTERVAL_MS: Record<ActionabilityFailure, number> = {
  NOT_ATTACHED: 0,    // immediate retry
  NOT_VISIBLE: 50,
  NOT_STABLE: 16,     // ~1 RAF
  OBSCURED: 100,
  DISABLED: 200,
  NOT_EDITABLE: -1,   // do not retry — semantic error, throw immediately
  OPEN_SHADOW: -1,    // Tier 2 起不再由 probe 发射：findInOpenShadow 已让 open-shadow 元素可解析。保留作安全网——若未来出现不可解析的 shadow 路径，此非重试分支避免 TIMEOUT 空转。
};

export interface WaitOptions extends CheckOptions {
  /** Default 5000ms. */
  timeout?: number;
}

export interface WaitOk {
  ok: true;
  rect: { x: number; y: number; w: number; h: number };
}

/**
 * Wait for the element to become actionable, retrying until ok or timeout.
 * Throws vtxError on failure (TIMEOUT / NOT_EDITABLE / etc).
 */
export async function waitActionable(
  tabId: number,
  frameId: number | undefined,
  selector: string,
  options: WaitOptions = {},
): Promise<WaitOk> {
  const timeout = Math.min(
    options.timeout ?? DEFAULT_TIMEOUT_MS,
    MAX_ACTIONABLE_TIMEOUT_MS,
  );
  const start = Date.now();
  let lastReason: ActionabilityFailure | null = null;
  let lastExtras: Record<string, unknown> | undefined;

  while (Date.now() - start < timeout) {
    const result: ActionabilityResult = await checkActionability(
      tabId,
      frameId,
      selector,
      options,
    );
    if (result.ok) {
      return { ok: true, rect: result.rect };
    }
    lastReason = result.reason;
    lastExtras = result.extras as Record<string, unknown> | undefined;

    const interval = RETRY_INTERVAL_MS[result.reason];
    if (interval < 0) {
      // Non-retryable semantic error (e.g. NOT_EDITABLE) — throw immediately.
      throw vtxError(
        mapToVtxCode(result.reason),
        `${result.reason} on selector "${selector}"`,
        { selector, extras: lastExtras },
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  // Timeout exhausted
  // V4 评测 P1-2 修复路径重做: 当 lastReason === 'NOT_STABLE' 时抛 NOT_STABLE
  // 错误码(非 TIMEOUT),让 errors.hints.ts NOT_STABLE hint (含 sticky/fixed +
  // transition + force=true 兜底建议) 生效。否则 LLM 收不到 force=true 提示,
  // 永远卡重试循环。518d500 修了 hint 文本但未改错误码,修复路径错(V4 报告 §7.3.2)。
  const lastReasonIsStability = lastReason === "NOT_STABLE";
  throw vtxError(
    lastReasonIsStability ? VtxErrorCode.NOT_STABLE : VtxErrorCode.TIMEOUT,
    lastReasonIsStability
      ? `Element not stable after ${timeout}ms (last reason: NOT_STABLE)`
      : `Actionability timeout after ${timeout}ms; last reason: ${lastReason ?? "unknown"}`,
    {
      selector,
      extras: { lastReason, ...(lastExtras ?? {}) },
    },
  );
}

/** Maps ActionabilityFailure to VtxErrorCode (precise mapping; T2.7 added the 6 L2 codes). */
function mapToVtxCode(reason: ActionabilityFailure): VtxErrorCode {
  switch (reason) {
    case "NOT_ATTACHED": return VtxErrorCode.NOT_ATTACHED;
    case "NOT_VISIBLE":  return VtxErrorCode.NOT_VISIBLE;
    case "NOT_STABLE":   return VtxErrorCode.NOT_STABLE;
    case "OBSCURED":     return VtxErrorCode.OBSCURED;
    case "DISABLED":     return VtxErrorCode.DISABLED;
    case "NOT_EDITABLE": return VtxErrorCode.NOT_EDITABLE;
    case "OPEN_SHADOW":  return VtxErrorCode.OPEN_SHADOW_DOM;
  }
}
