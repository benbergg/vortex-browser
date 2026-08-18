// L2 Action - Auto-wait (RAF polling + reason-aware retry).
// Reference: design doc §5.3 + docs/spec-l2-action.md §2.
//
// Default timeout 2000ms (was 5000ms; tightened in 2026-06-09 JD home-search perf optimization).
// Each reason has its own retry interval (per spec §2 table).
// On timeout exhaustion, throws vtxError(TIMEOUT) with extras.lastReason carrying the last failure code.

import { ANCESTOR_HIT_HINT, VtxErrorCode, vtxError } from "@vortex-browser/shared";
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
  INVALID_SELECTOR: -1, // 语法错重试不会变合法：立即抛,附正确语法(此前当 NOT_ATTACHED 空转满预算)
};

export interface WaitOptions extends CheckOptions {
  /** Default 2000ms. */
  timeout?: number;
}

export interface WaitOk {
  ok: true;
  rect: { x: number; y: number; w: number; h: number };
}

export interface ActionabilityTimeoutDiagnosis {
  message: string;
  /** 非空时经 vtxError 第 4 参覆盖该错误码的默认 hint。 */
  hint?: string;
}

/**
 * Builds the OBSCURED 分支超时诊断(modalBlocked/noHit/祖先命中/普通遮挡/兜底)。
 * message 与 hint 同一处产出:MCP 把两者一起渲染给模型,分开算必然再次分叉。
 * lastReasonIsStability/inertBlocked 仍留在 waitActionable 内联——不属于 OBSCURED 分支。
 */
export function buildActionabilityTimeoutDiagnosis(a: {
  timeout: number;
  lastReason?: string;
  lastExtras?: { blocker?: string; hitKind?: string; modalBlocked?: boolean };
}): ActionabilityTimeoutDiagnosis {
  const { timeout, lastReason, lastExtras } = a;
  const modalBlocked = lastReason === "OBSCURED" && lastExtras?.modalBlocked === true;
  const blocker = lastReason === "OBSCURED" && !modalBlocked ? lastExtras?.blocker : undefined;
  const noHit = blocker === "elementFromPoint=null";
  if (modalBlocked) {
    return { message: `Actionability timeout after ${timeout}ms; last reason: OBSCURED ` +
      `(element is covered by an open modal <dialog> in the top layer; the rest of the page is ` +
      `inert while it is open — dismiss the dialog first, e.g. press Escape or click its close button, then retry)` };
  }
  if (noHit) {
    return { message: `Hit-testing the element's center reached no element at all after ${timeout}ms ` +
      `(clipped by an ancestor, or positioned outside the viewport)` };
  }
  // 祖先命中:目标在 DOM 里、CSS 上也"可见",但中心点 hit-test 落到自己的祖先——
  // 被祖先 overflow:hidden 裁掉、pointer-events:none、或祖先自身层压在上面。
  // 与浮层遮挡的修法完全不同,不能让调用方去关一个不存在的浮层。
  if (blocker && lastExtras?.hitKind === "ancestor") {
    return {
      message: `Element's center hit-tests to its own ancestor <${blocker}> after ${timeout}ms ` +
        `(clipped by that ancestor, pointer-events:none, or the ancestor paints over it) — ` +
        `a real click at those coordinates would not reach the target; ` +
        `scroll that container to bring the element into its visible area, or target the element that actually receives the click`,
      // 默认 OBSCURED hint 指引去关浮层,祖先命中时根本没有浮层可关
      hint: ANCESTOR_HIT_HINT,
    };
  }
  if (blocker) {
    return { message: `Element is covered by <${blocker}> after ${timeout}ms of retrying; ` +
      `hit-testing its center reaches that element, not the target` };
  }
  return { message: `Actionability timeout after ${timeout}ms; last reason: ${lastReason ?? "unknown"}` };
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
      // ARIA value 控件(role=slider/spinbutton)无 input 可填,但可经键盘/drag 设值 →
      // 给出可 actionable 指引,替代通用 NOT_EDITABLE hint 误导的「point to an actual input」
      // (根本无 input)。沿用 inertBlocked/modalBlocked 经 extras 定制 message 的模式。
      const ariaValueWidget =
        result.reason === "NOT_EDITABLE"
          ? (lastExtras?.ariaValueWidget as string | undefined)
          : undefined;
      // 语法错的诊断必须自带正确语法。此前走 NOT_ATTACHED 空转到 TIMEOUT,
      // 抛 "Element detached from DOM" 把调用方推向"时序问题"的错误方向
      // (2026-07-29 iPaaS 实战:加 timeout / wait idle 全部无效)。
      // 不重复码名前缀：router 外层已渲染成 `Error [INVALID_SELECTOR]: …`，
      // 与相邻 NOT_EDITABLE 分支的写法对齐。恢复指引统一由 errors.hints 提供。
      const invalidSelector =
        result.reason === "INVALID_SELECTOR"
          ? `Selector "${selector}" is not valid CSS (querySelector rejected it). ` +
            `If this selector was generated by vortex_observe, re-run vortex_observe to get a fresh ref.`
          : undefined;
      const message = invalidSelector
        ? invalidSelector
        : ariaValueWidget
        ? `NOT_EDITABLE on selector "${selector}" (role=${ariaValueWidget} is an ARIA value widget ` +
          `with no fillable input — set its value with vortex_press Arrow/Home/End keys after focusing it, ` +
          `or drag the thumb with vortex_mouse_drag; do not use vortex_fill)`
        : `${result.reason} on selector "${selector}"`;
      throw vtxError(
        mapToVtxCode(result.reason),
        message,
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
  // inert 子树致 DISABLED(常见于加载即弹 modal/overlay 把背景内容设为 inert)→ 泛化
  // "增大 timeout / wait_for idle" hint 误导(等待无用),追加可 actionable 的关遮挡指引。
  const inertBlocked = lastReason === "DISABLED" && lastExtras?.inert === true;
  // 原生 <dialog>.showModal() 背景化致 OBSCURED(浏览器隐式 inert 不设 [inert] 属性,
  // R6 的 inertBlocked 分支命中不了)→ 同样追加关 modal 指引(等待/idle 无用,正解关
  // dialog)。modalBlocked 由 actionability probe 经 `dialog:modal` 判据携带。
  let message: string;
  let hintOverride: string | undefined;
  if (lastReasonIsStability) {
    message = `Element not stable after ${timeout}ms (last reason: NOT_STABLE)`;
  } else if (inertBlocked) {
    message =
      `Actionability timeout after ${timeout}ms; last reason: DISABLED ` +
      `(element is in an [inert] subtree — commonly a modal/overlay backgrounding the page; ` +
      `dismiss the overlay/modal first, e.g. press Escape or click its close button, then retry)`;
  } else {
    const diagnosis = buildActionabilityTimeoutDiagnosis({
      timeout,
      lastReason: lastReason ?? undefined,
      lastExtras: lastExtras as
        | { blocker?: string; hitKind?: string; modalBlocked?: boolean }
        | undefined,
    });
    message = diagnosis.message;
    hintOverride = diagnosis.hint;
  }
  // OBSCURED 不再压成 TIMEOUT:TIMEOUT 的 hint 是「加大 timeout / 等 idle」,对遮挡是
  // 死路,而 OBSCURED 自带「关掉浮层再重试」。同 NOT_STABLE 的先例(见上方注释)——
  // 只改 hint 文本不改错误码,修复路径就是错的。
  throw vtxError(
    lastReasonIsStability
      ? VtxErrorCode.NOT_STABLE
      : lastReason === "OBSCURED"
        ? VtxErrorCode.OBSCURED
        : VtxErrorCode.TIMEOUT,
    message,
    {
      selector,
      extras: { lastReason, ...(lastExtras ?? {}) },
    },
    hintOverride ? { hint: hintOverride } : undefined,
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
    case "INVALID_SELECTOR": return VtxErrorCode.INVALID_SELECTOR;
  }
}
