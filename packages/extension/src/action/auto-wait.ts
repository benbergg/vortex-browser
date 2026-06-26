// L2 Action - Auto-wait (RAF polling + reason-aware retry).
// Reference: design doc §5.3 + docs/spec-l2-action.md §2.
//
// Default timeout 2000ms (was 5000ms; tightened in 2026-06-09 JD home-search perf optimization).
// Each reason has its own retry interval (per spec §2 table).
// On timeout exhaustion, throws vtxError(TIMEOUT) with extras.lastReason carrying the last failure code.

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";
import {
  checkActionability,
  type ActionabilityFailure,
  type ActionabilityResult,
  type CheckOptions,
} from "./actionability.js";

const DEFAULT_TIMEOUT_MS = 2000;

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
  /** Default 2000ms. */
  timeout?: number;
  /** B2:持续 NOT_ATTACHED 达阈值时按 descriptor 重定位,返回新 selector(无则 null)。@since 当前版本 */
  reresolve?: () => Promise<string | null>;
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

  // B2:descriptor 重定位阈值。持续 NOT_ATTACHED 累计超过此值即按 descriptor 重定位
  // (而非死等整个 timeout 后才自愈一次),应对虚拟表格/富文本高频重渲染。
  const RERESOLVE_AFTER_MS = 500;
  let curSelector = selector;
  let notAttachedSince: number | null = null;
  let reresolved = false;

  while (Date.now() - start < timeout) {
    const result: ActionabilityResult = await checkActionability(
      tabId,
      frameId,
      curSelector,
      options,
    );
    if (result.ok) {
      return { ok: true, rect: result.rect };
    }
    lastReason = result.reason;
    lastExtras = result.extras as Record<string, unknown> | undefined;

    if (result.reason === "NOT_ATTACHED" && options.reresolve && !reresolved) {
      const now = Date.now();
      if (notAttachedSince === null) notAttachedSince = now;
      else if (now - notAttachedSince >= RERESOLVE_AFTER_MS) {
        const next = await options.reresolve();
        reresolved = true; // 每跑 gate 最多重定位一次,避免抖动无限重定位
        if (next) { curSelector = next; notAttachedSince = null; continue; }
      }
    } else if (result.reason !== "NOT_ATTACHED") {
      notAttachedSince = null;
    }

    const interval = RETRY_INTERVAL_MS[result.reason];
    if (interval < 0) {
      // Non-retryable semantic error (e.g. NOT_EDITABLE) — throw immediately.
      // ARIA value 控件(role=slider/spinbutton)无 input 可填,但可经键盘/drag 设值 →
      // 给出可 actionable 指引,替代通用 NOT_EDITABLE hint 误导的「point to an actual input」
      // (根本无 input)。沿用 inertBlocked/modalBlocked 经 extras 定制 message 的模式。
      const ariaValueWidget =
        result.reason === "NOT_EDITABLE"
          ? (lastExtras?.ariaValueWidget as string | undefined)
          : undefined;
      const message = ariaValueWidget
        ? `NOT_EDITABLE on selector "${curSelector}" (role=${ariaValueWidget} is an ARIA value widget ` +
          `with no fillable input — set its value with vortex_press Arrow/Home/End keys after focusing it, ` +
          `or drag the thumb with vortex_mouse_drag; do not use vortex_fill)`
        : `${result.reason} on selector "${curSelector}"`;
      throw vtxError(
        mapToVtxCode(result.reason),
        message,
        { selector: curSelector, extras: lastExtras },
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
  // inert 子树致 DISABLED(常见于加载即弹 modal/overlay 把背景内容设为 inert)→ 泛化
  // "增大 timeout / wait_for idle" hint 误导(等待无用),追加可 actionable 的关遮挡指引。
  const inertBlocked = lastReason === "DISABLED" && lastExtras?.inert === true;
  // 原生 <dialog>.showModal() 背景化致 OBSCURED(浏览器隐式 inert 不设 [inert] 属性,
  // R6 的 inertBlocked 分支命中不了)→ 同样追加关 modal 指引(等待/idle 无用,正解关
  // dialog)。modalBlocked 由 actionability probe 经 `dialog:modal` 判据携带。
  const modalBlocked = lastReason === "OBSCURED" && lastExtras?.modalBlocked === true;
  let message: string;
  if (lastReasonIsStability) {
    message = `Element not stable after ${timeout}ms (last reason: NOT_STABLE)`;
  } else if (inertBlocked) {
    message =
      `Actionability timeout after ${timeout}ms; last reason: DISABLED ` +
      `(element is in an [inert] subtree — commonly a modal/overlay backgrounding the page; ` +
      `dismiss the overlay/modal first, e.g. press Escape or click its close button, then retry)`;
  } else if (modalBlocked) {
    message =
      `Actionability timeout after ${timeout}ms; last reason: OBSCURED ` +
      `(element is covered by an open modal <dialog> in the top layer; the rest of the page is ` +
      `inert while it is open — dismiss the dialog first, e.g. press Escape or click its close button, then retry)`;
  } else if (lastReason === "NOT_ATTACHED") {
    message =
      `Actionability timeout after ${timeout}ms; last reason: NOT_ATTACHED ` +
      `(element kept detaching — likely a re-rendering SPA, e.g. virtual-scroll table or rich-text editor). ` +
      `Re-run vortex_observe immediately before act to refresh the ref; for highly dynamic regions ` +
      `locate via vortex_evaluate (query the live DOM or framework instance, e.g. el.__vueParentComponent); ` +
      `or raise timeout.`;
  } else {
    message = `Actionability timeout after ${timeout}ms; last reason: ${lastReason ?? "unknown"}`;
  }
  throw vtxError(
    lastReasonIsStability ? VtxErrorCode.NOT_STABLE : VtxErrorCode.TIMEOUT,
    message,
    {
      selector: curSelector,
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
