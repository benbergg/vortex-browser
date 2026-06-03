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
    hint: "Vortex extension is not connected. Ensure Chrome is open with the extension enabled at chrome://extensions, then call vortex_observe to re-check connectivity.",
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
  NOT_VISIBLE: {
    hint: "Element not visible (display:none / visibility:hidden / 0x0 box). Call vortex_wait_for with mode='element' on a parent visibility marker, or check whether the parent container is hidden.",
    recoverable: true,
  },
  NOT_STABLE: {
    hint: "Element position is unstable (animating). Call vortex_wait_for with mode='idle' to let the animation settle, then retry vortex_act.",
    recoverable: true,
  },
  OBSCURED: {
    hint: "Element hit-test failed; covered by another element (e.g. modal / loading overlay). Inspect via vortex_screenshot, dismiss the overlay (context.extras.blocker may identify it), then retry.",
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
    hint: "Descriptor matched multiple elements in strict mode. Add a 'near' relation to disambiguate, narrow the name attribute, or set strict:false to take the first match.",
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
