import { VtxError, VtxErrorCode } from "./errors.js";
import type { VtxErrorContext, VtxErrorExtra } from "./errors.js";

/**
 * 错误元信息：给上游 LLM Agent 的恢复提示。
 *
 * `recoverable` 语义：
 * - `true`：同一动作带参数调整后重试可能成功（如 ELEMENT_OCCLUDED 清理遮挡后重试）
 * - `false`：同一动作重试无意义，但 hint 可能指引换一个动作达成目标
 *   （如 TAB_CLOSED 需要换 tab，不是动作本身的重试）
 *
 * Hint quality contract（I19 + I20，see L5-spec §1.2/§1.4）:
 * - 含 next-action 动词（call/use/verify/check/retry/wait/set/inspect/...）
 * - 含工具名 OR 参数关键词（vortex_*, selector, mode, action, ...）
 * - 长度 50-300 字符
 * - 引用工具名必须在 v0.6 公开 11 之内（否则 LLM tools/list 看不到）
 */
export interface VtxErrorMeta {
  hint: string;
  recoverable: boolean;
}

/**
 * 祖先命中的 hint。修法与浮层遮挡相反(没有浮层可关),故走 vtxError 第 4 参覆盖
 * 默认 OBSCURED / ELEMENT_OCCLUDED 话术。门、CDP、合成三条路径共用这一份。
 */
export const ANCESTOR_HIT_HINT =
  "Hit-testing lands on one of the element's own ancestors, not on an overlay — no floating layer to close, and waiting will not help. Call vortex_act with action='scroll' on that ancestor to bring the target's center into its visible box, or retry on the element that truly receives the click.";

/**
 * 祖先命中的核心话术。门 / CDP / 合成三条路径共用,各自只追加自己的上下文,
 * 否则「同一判据、三种说法」会重演(2026-08-18 评审 I1)。
 */
export function ancestorHitMessage(target: string, blocker: string): string {
  return (
    `${target}'s center hit-tests to its own ancestor <${blocker}> ` +
    `(clipped by that ancestor, pointer-events:none, or the ancestor paints over it) — ` +
    `a real click at those coordinates would not reach the target`
  );
}

export const NO_HIT_HINT =
  "Hit-testing the element's center reached no element at all — it is clipped by an ancestor or sits outside the viewport, so no covering element exists. Call vortex_act with action='scroll' to bring it into view, then call vortex_observe to confirm its box before retrying.";

/**
 * 中心点落空的核心话术。blocker 串 "elementFromPoint=null" 不是元素描述,
 * 按遮挡话术渲染会造出 `covered by <elementFromPoint=null>` 这种荒谬报文。
 */
export function noHitMessage(target: string): string {
  return (
    `Hit-testing ${target}'s center reached no element at all ` +
    `(clipped by an ancestor, or positioned outside the viewport)`
  );
}

export const TIMEOUT_PAGE_ALIVE_HINT =
  "The page's main thread still responds, so the stall is in this action's own path (a CDP command queued, or chrome.debugger held by another client). Close DevTools on this tabId, then retry; raising the timeout argument only helps if the path is merely slow.";

export const TIMEOUT_PAGE_UNRESPONSIVE_HINT =
  "The page's main thread is blocked by a long task, so it never answered within the action budget — waiting longer and a bigger timeout argument are both useless. Call vortex_navigate to reload and reset this tab, or call vortex_tab_list and retry on another live tabId.";

/** 探活没做成时只能说「原因未判定」。声称页面死活正是本次要消灭的假信号。 */
export const TIMEOUT_PROBE_FAILED_HINT =
  "The liveness probe itself could not run on this tab (no host permission, a chrome:// page, or a discarded tab), so the timeout cause is undetermined. Call vortex_observe on this tabId to check whether the page is reachable at all before retrying.";

export const TIMEOUT_TAB_GONE_HINT =
  "The target tab no longer exists or cannot be accessed, so this action can never complete on that tabId. Call vortex_tab_list to see which tabs are still open and retry with a live tabId, or vortex_tab_create if none of them fits.";

/** 超时归因的四态。扩态时 TIMEOUT_LIVENESS_META 少一条即编译失败,不静默回落默认 hint */
export type TimeoutLiveness = "page-alive" | "page-unresponsive" | "probe-failed" | "tab-gone";

/**
 * 内层 deadline 到点后按探活结果分发的 hint + recoverable。两者必须同处一地:
 * hint 说「重试无用」而 recoverable=true 会自相矛盾(2026-08-18 裁决三)。
 */
export const TIMEOUT_LIVENESS_META: Readonly<Record<TimeoutLiveness, VtxErrorMeta>> = Object.freeze({
  "page-alive": { hint: TIMEOUT_PAGE_ALIVE_HINT, recoverable: true },
  "probe-failed": { hint: TIMEOUT_PROBE_FAILED_HINT, recoverable: true },
  "page-unresponsive": { hint: TIMEOUT_PAGE_UNRESPONSIVE_HINT, recoverable: false },
  "tab-gone": { hint: TIMEOUT_TAB_GONE_HINT, recoverable: false },
});

/**
 * 经 vtxError 第 4 参下发的 override hint 登记表。它们和 DEFAULT_ERROR_META 一样
 * 直达 LLM,故必须一起受 I19/I20 不变量扫描——不登记就是绕过契约。
 */
export const OVERRIDE_HINTS: Record<string, string> = {
  ANCESTOR_HIT_HINT,
  NO_HIT_HINT,
  TIMEOUT_PAGE_ALIVE_HINT,
  TIMEOUT_PAGE_UNRESPONSIVE_HINT,
  TIMEOUT_PROBE_FAILED_HINT,
  TIMEOUT_TAB_GONE_HINT,
};

export const DEFAULT_ERROR_META: Record<VtxErrorCode, VtxErrorMeta> = {
  // -- 元素定位 --
  ELEMENT_NOT_FOUND: {
    hint: "Element not found. Verify the selector or call vortex_observe to list interactive elements with their refs. If the element may live inside an iframe, call vortex_observe with scope='full' to descend into iframes — the returned element.frameId routes follow-up vortex_act correctly.",
    recoverable: true,
  },
  ELEMENT_OCCLUDED: {
    hint: "Element is covered by another (modal / overlay / cookie banner). Inspect via vortex_screenshot to identify the blocker, dismiss it via vortex_act with action='click' on its close selector, then retry.",
    recoverable: true,
  },
  ELEMENT_OFFSCREEN: {
    hint: "Element is outside the viewport. Call vortex_act with action='scroll' on the target to bring it into view, then retry the original action.",
    recoverable: true,
  },
  ELEMENT_DISABLED: {
    hint: "Element has the disabled attribute. Fill required prior fields via vortex_act or satisfy prerequisites to enable it, then retry.",
    recoverable: true,
  },
  ELEMENT_DETACHED: {
    hint: "Element was removed from the DOM. Call vortex_observe to capture the current state and retry with the new ref.",
    recoverable: true,
  },
  SELECTOR_AMBIGUOUS: {
    hint: "Selector matched multiple elements. Use a more specific selector, or call vortex_observe to get unique ref indexes (@eN form).",
    recoverable: true,
  },

  // -- 页面状态 --
  NAVIGATION_IN_PROGRESS: {
    hint: "A page navigation is in progress. Call vortex_wait_for with mode='idle' and value='network' before retrying the action.",
    recoverable: true,
  },
  PAGE_NOT_READY: {
    hint: "Page DOM is not ready. Call vortex_wait_for with mode='element' on a load-marker selector, or mode='idle' value='network', before retrying.",
    recoverable: true,
  },
  DIALOG_BLOCKING: {
    hint: "A native browser dialog (alert / confirm / prompt) is blocking. Handle or dismiss it via vortex_act with action='click' on the OK / Cancel selector, then retry.",
    recoverable: true,
  },
  IFRAME_NOT_READY: {
    hint: "Target iframe is not ready or not yet loaded. Retry vortex_observe with scope='full' to descend into iframes — the returned elements carry frameId so follow-up vortex_act routes correctly.",
    recoverable: true,
  },

  // -- Snapshot --
  STALE_SNAPSHOT: {
    hint: "Page has changed since the snapshot. Call vortex_observe to capture a fresh snapshot, then retry with the new ref.",
    recoverable: true,
  },
  INVALID_INDEX: {
    hint: "Index does not exist in this snapshot. Call vortex_observe to list valid ref indexes (@eN form).",
    recoverable: true,
  },

  // -- 网络与标签 --
  NAVIGATION_FAILED: {
    hint: "Navigation failed (network error, blocked URL, or invalid URL). Verify the url argument passed to vortex_navigate and retry; the context may carry the underlying browser error.",
    recoverable: true,
  },
  TAB_NOT_FOUND: {
    hint: "tabId argument does not exist. Call vortex_tab_create to open a new tab, or omit tabId to operate on the active tab.",
    recoverable: false,
  },
  TAB_CLOSED: {
    hint: "The target tab was closed during execution. Call vortex_tab_create to open a new tab and re-run the flow, or pick another tabId.",
    recoverable: false,
  },

  // -- 执行与权限 --
  TIMEOUT: {
    hint: "Action timed out. Increase the timeout argument, or call vortex_wait_for with mode='idle' to let the page settle before retrying.",
    recoverable: true,
  },
  JS_EXECUTION_ERROR: {
    hint: "Injected JavaScript threw an error. Inspect the error message in context.extras and adjust the selector or action arguments before retrying.",
    recoverable: false,
  },
  PERMISSION_DENIED: {
    hint: "Operation blocked by browser permission (cross-origin, file access, or extension permission). Verify the manifest permissions attribute and the target tab is not chrome://.",
    recoverable: false,
  },
  CSP_BLOCKED: {
    hint: "Action blocked by Content-Security-Policy. Use vortex_act with action='click' (which routes via CDP real mouse and bypasses page-side CSP), or pick a selector outside the CSP-restricted frame.",
    recoverable: true,
  },
  INTERNAL_ERROR: {
    hint: "Unexpected error in the vortex runtime (server / mcp). Inspect context.extras for the underlying message and retry — transient errors often recover.",
    recoverable: true,
  },

  // -- 传输层 --
  NATIVE_MESSAGING_ERROR: {
    hint: "Native messaging channel error. Verify the vortex host is installed and the extension is reloaded; inspect the chrome://extensions page for the connection state.",
    recoverable: false,
  },
  EXTENSION_NOT_CONNECTED: {
    hint: "Vortex extension is not connected. Ensure the target browser (Chrome / Edge / …) is open with the vortex extension enabled, then call vortex_observe to re-check connectivity. Set VORTEX_BROWSER to pin a specific browser.",
    recoverable: false,
  },
  INVALID_PARAMS: {
    hint: "Invalid parameters. Check the tool schema for required fields and value constraints, then retry with corrected arguments.",
    recoverable: false,
  },
  UNKNOWN_ACTION: {
    hint: "Unknown action. Verify the action argument spelling matches the tool's enum (e.g. vortex_act expects click / fill / type / select / scroll / hover).",
    recoverable: false,
  },

  // -- 组件 / 框架 --
  UNSUPPORTED_TARGET: {
    hint: "Target is a framework-controlled component (e.g. Element Plus datetime-range picker). The runtime auto-routes to a commit driver via vortex_act; if the framework version is not yet covered, inspect context.extras.kind and pick a CSS selector outside the controlled region.",
    recoverable: false,
  },
  COMMIT_FAILED: {
    hint: "Commit driver failed mid-flow. Inspect context.extras.stage (open-picker / navigate-month / click-day / confirm / verify) to see which step broke; the page state may have changed or the framework version may not be matched by any driver.",
    recoverable: true,
  },

  // -- L2 Action layer --
  NOT_ATTACHED: {
    hint: "Element detached from DOM. Call vortex_observe to re-locate the element and retry vortex_act with the fresh ref.",
    recoverable: true,
  },
  INVALID_SELECTOR: {
    hint: "target is not valid CSS. Use a CSS selector (e.g. button.save-btn, input[placeholder='Name']) or an @ref from vortex_observe. Playwright syntax (text=, >>, :has-text()) and plain text are not supported; to match by text call vortex_observe and use its ref.",
    recoverable: false,
  },
  NOT_VISIBLE: {
    hint: "Element not visible (display:none / visibility:hidden / 0x0 box). Call vortex_wait_for with mode='element' on a parent visibility marker, or check whether the parent container is hidden.",
    recoverable: true,
  },
  NOT_STABLE: {
    // vortex-bench 2026-06-07 淘宝评测 V3 §3.3 P1-2 残留降级:
    // sticky/fixed 容器 + CSS transition 场景(如天猫"加入购物车"按钮
    // `transition: bottom 0.15s`)下 0.5px 容差仍不够。修法不是改代码
    // (项目 c8928c0 已判定时序不可控),而是让 hint 让 LLM 一次看明白
    // 降级路径:force=true 走 CDP realMouse 跳过 stability check。
    hint: "Element position is unstable. If it sits inside a sticky/fixed ancestor with a CSS transition (e.g. `transition: bottom 0.15s`), retry vortex_act with options: { force: true } to bypass the stability check (CDP realMouse). Otherwise call vortex_wait_for mode='idle' to let the animation settle.",
    recoverable: true,
  },
  OBSCURED: {
    // 原文让调用方去看 context.extras.blocker —— 那是个它永远看不到的字段(MCP 只渲染
    // message + hint)。遮挡者现由 message 直接点名,指引改为可执行的下一步。
    // 别在这里推荐 force:true —— 它现已穿透门/CDP/合成三条路径,但跳过的是全部质量门
    // (可见性/可用性/稳定性…),对通用 hint 来说是危险的逃生舱,不该推荐给 LLM。
    hint: "Element hit-test failed; another element covers it (the covering element is named in the message). Waiting will not help and neither will a larger timeout — dismiss or scroll away that element (e.g. vortex_act click on its close control), then retry.",
    recoverable: true,
  },
  DISABLED: {
    hint: "Element is disabled (disabled attribute / aria-disabled / fieldset[disabled]). Complete prerequisite vortex_act interactions to unlock it before retrying.",
    recoverable: true,
  },
  NOT_EDITABLE: {
    hint: "Target is not editable (readonly or non-input element). Use vortex_extract to read its text instead, or pick a different selector that points to an actual input.",
    recoverable: false,
  },
  ACTION_FAILED_ALL_PATHS: {
    hint: "All fallback paths exhausted (dispatchEvent → CDP → ...). context.extras.attemptedPaths lists what was tried. Inspect via vortex_screenshot, retry with a different selector, or check whether the element lives in a closed shadow root.",
    recoverable: false,
  },
  DRAG_REQUIRES_CDP: {
    hint: "Drag operation requires CDP, but CDP is unavailable (DevTools may be open, or chrome.debugger attach was denied). Close DevTools and retry; drag is exposed via vortex_act with action='drag' once CDP attaches.",
    recoverable: false,
  },

  // -- L3 Reasoning（@since 0.6.0 PR #3）--
  A11Y_UNAVAILABLE: {
    hint: "Accessibility tree unavailable on this page (CSP-restricted or sandboxed). Switch to a regular page or fall back to CSS selectors via vortex_act and vortex_extract.",
    recoverable: false,
  },
  CDP_NOT_ATTACHED: {
    hint: "chrome.debugger could not attach to the tab. Verify the manifest debugger attribute is granted, and the tab is not chrome:// or chrome-extension:// (CDP cannot attach to those).",
    recoverable: false,
  },
  STALE_REF: {
    hint: "Element ref is stale and could not be re-resolved by descriptor. Call vortex_observe to mint fresh refs and retry.",
    recoverable: true,
  },
  AMBIGUOUS_DESCRIPTOR: {
    hint: "Descriptor (role+name) matched multiple elements during self-heal; refused to act to avoid the wrong target. Call vortex_observe to mint fresh refs and retry.",
    recoverable: true,
  },
  REF_NOT_FOUND: {
    hint: "ref does not exist in the current RefStore. Call vortex_observe to mint fresh refs and retry the action.",
    recoverable: true,
  },
  SNAPSHOT_EXPIRED: {
    hint: "Snapshot expired (> 5 min). Call vortex_observe to capture a new snapshot and retry with the fresh ref.",
    recoverable: true,
  },
  CROSS_ORIGIN_IFRAME: {
    hint: "Accessibility.getFullAXTree was rejected for a cross-origin frameId; the AX tree cannot be queried across origin boundaries. Switch to a same-origin entry point or operate within the iframe via its own tab context.",
    recoverable: false,
  },
  CLOSED_SHADOW_DOM: {
    hint: "Element lives inside a closed shadow root and cannot be pierced. Ask the component author to switch the mode attribute to 'open', or expose an ARIA-rich light-DOM proxy selector.",
    recoverable: false,
  },

  OPEN_SHADOW_DOM: {
    hint: "Element lives inside an open shadow root that vortex_observe surfaced but act cannot reach via a CSS selector. Expose a light-DOM proxy selector for the control, or have the component render the actionable element in light DOM.",
    recoverable: false,
  },

  NO_MATCHING_OPTION: {
    hint: "The select value matched no <option> by value attribute or visible text. Read the available options (listed in context.extras.available) and retry vortex_act select with an exact option value or label.",
    recoverable: true,
  },
  NO_EFFECT: {
    hint: "The action dispatched but a post-action read-back showed no real change (option not selected, page not scrolled, state unchanged). The target may be a disabled option or a no-op scroll. Re-observe and verify the element is operable before retrying.",
    recoverable: true,
  },

  // -- L4 Task layer（@since 0.6.0 PR #4）--
  INVALID_TARGET: {
    hint: "Use a target ref string like @e3 (returned from vortex_observe) or a CSS selector. The Descriptor object form arrives in v0.6.x once the resolver lands.",
    recoverable: false,
  },
  UNSUPPORTED_ACTION: {
    hint: "Verify the action argument matches one of vortex_act's enum values: click, fill, type, select, scroll, hover. The drag action is not yet exposed via vortex_act in v0.6.",
    recoverable: false,
  },
};

/**
 * 便捷构造 VtxError：自动注入 DEFAULT_ERROR_META 的 hint 与 recoverable。
 * 调用方只需传 code / message / context。
 * 如需覆盖默认 hint 或 recoverable，传 `override` 参数。
 */
export function vtxError(
  code: VtxErrorCode,
  message: string,
  context?: VtxErrorContext,
  override?: Partial<VtxErrorMeta>,
): VtxError {
  const meta = DEFAULT_ERROR_META[code];
  const extra: VtxErrorExtra = {
    hint: override?.hint ?? meta.hint,
    recoverable: override?.recoverable ?? meta.recoverable,
  };
  if (context !== undefined) extra.context = context;
  return new VtxError(code, message, extra);
}
