// L2 Action - Host-side Actionability wrapper.
// Calls page-side bundle's window.__vortexActionability.probe via chrome.scripting; host-side is orchestration only.
//
// Design:
// - alias pattern (PR #1 experience): const probe = (...) => nativePageQuery(...) closes over tabId/frameId,
//   matching cdp-driver call shape from PR #1.
// - Stable re-check: after probe ok, call probeStable separately (two-step async because RAF cannot compose
//   across the chrome.scripting boundary).
//
// Public API:
//   checkActionability(tabId, frameId, selector, options?) → ActionabilityResult

import { pageQuery as nativePageQuery, PageQueryTimeoutError } from "../adapter/native.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";
import type {
  ActionabilityFailure,
  ActionabilityResult,
} from "../page-side/actionability.js";

export type { ActionabilityFailure, ActionabilityResult };

// 探针 executeScript 超时上限(ms)。须明显低于 waitActionable 默认 5000ms 预算,
// 使坏 tab 态下「永不 settle 的探针」在预算内超时重试,最终抛有界 TIMEOUT。
const PROBE_TIMEOUT_MS = 2000;

export interface CheckOptions {
  /** True for fill/type, false for click/hover. Default false. */
  needsEditable?: boolean;
  /** Skip the Stable re-check (when auto-wait already does stable check in retry loop). Default false. */
  skipStable?: boolean;
  /**
   * Force mode (Playwright 语义):跳过质量门(visible/enabled/editable/obscured)+ stable 复查,
   * 仅要求元素 attached。供 act options.force 绕过 actionability(2026-06-04 H 族)。
   */
  force?: boolean;
}

/**
 * Single-shot actionability probe (no wait; caller orchestrates retries via auto-wait).
 * Returns ActionabilityResult; ok=false includes reason + extras.
 */
export async function checkActionability(
  tabId: number,
  frameId: number | undefined,
  selector: string,
  options: CheckOptions = {},
): Promise<ActionabilityResult> {
  await loadPageSideModule(tabId, frameId, "actionability");

  // 探针 executeScript 加界(PROBE_TIMEOUT_MS):坏 tab 态下 executeScript 会永不
  // settle,而 waitActionable 预算只在循环顶部查,无界 await 会绕过预算挂到 30s。
  // 取 2000ms:正常探针 <100ms,20x 余量不误超时;且明显 < waitActionable 默认
  // 5000ms 预算,使预算能在 2~3 次重试内真正触发(2026-06-03 press-combo flake)。
  // alias pattern: closure-bind tabId/frameId for repeated probe calls
  const probe = <T>(fn: (...args: unknown[]) => T, args: unknown[] = []) =>
    nativePageQuery<T>(tabId, frameId, fn, args, PROBE_TIMEOUT_MS);

  // 探针超时(executeScript 永不 settle)→ 映射为可重试 NOT_ATTACHED,让
  // waitActionable 在预算内复查并最终抛**有界 TIMEOUT**,而非 30s 静默挂死。
  let result: ActionabilityResult;
  try {
    result = await probe<ActionabilityResult>(
      (sel: string, needsEditable: boolean, force: boolean) => {
        const A = (window as any).__vortexActionability;
        if (!A?.probe) {
          // Bundle not loaded: treat as element-not-found (caller will retry via auto-wait).
          return { ok: false, reason: "NOT_ATTACHED" } as const;
        }
        return A.probe(sel, needsEditable, force);
      },
      [selector, options.needsEditable ?? false, options.force ?? false],
    );
  } catch (err) {
    // 只把「探针 executeScript 永不 settle 超时」映射为可重试 NOT_ATTACHED;
    // 真实 executeScript 错误(tab 关闭 / 无 frame)透传,保持快速失败。
    if (err instanceof PageQueryTimeoutError) {
      return { ok: false, reason: "NOT_ATTACHED" };
    }
    throw err;
  }

  if (!result.ok) return result;
  // force:跳过 stable 复查(质量门已整体跳过,稳定性同属质量门)。
  if (options.skipStable || options.force) return result;

  // Stable re-check (two-step async)。同样加界:超时映射 NOT_STABLE(可重试)。
  let stable: { ok: boolean };
  try {
    stable = await probe<{ ok: boolean }>(
      (sel: string) => {
        const A = (window as any).__vortexActionability;
        return A.probeStable(sel);
      },
      [selector],
    );
  } catch (err) {
    if (err instanceof PageQueryTimeoutError) {
      return { ok: false, reason: "NOT_STABLE" };
    }
    throw err;
  }
  if (!stable.ok) {
    return { ok: false, reason: "NOT_STABLE" };
  }
  return result;
}
