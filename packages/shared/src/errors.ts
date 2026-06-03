export const VtxErrorCode = {
  // -- 元素定位（6 类）--
  ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
  ELEMENT_OCCLUDED: "ELEMENT_OCCLUDED",
  ELEMENT_OFFSCREEN: "ELEMENT_OFFSCREEN",
  ELEMENT_DISABLED: "ELEMENT_DISABLED",
  ELEMENT_DETACHED: "ELEMENT_DETACHED",
  SELECTOR_AMBIGUOUS: "SELECTOR_AMBIGUOUS",

  // -- 页面状态（4 类）--
  NAVIGATION_IN_PROGRESS: "NAVIGATION_IN_PROGRESS",
  PAGE_NOT_READY: "PAGE_NOT_READY",
  DIALOG_BLOCKING: "DIALOG_BLOCKING",
  IFRAME_NOT_READY: "IFRAME_NOT_READY",

  // -- Snapshot（2 类，配合 vortex_observe）--
  STALE_SNAPSHOT: "STALE_SNAPSHOT",
  INVALID_INDEX: "INVALID_INDEX",

  // -- 网络与标签（3 类）--
  NAVIGATION_FAILED: "NAVIGATION_FAILED",
  TAB_NOT_FOUND: "TAB_NOT_FOUND",
  TAB_CLOSED: "TAB_CLOSED",

  // -- 执行与权限（5 类）--
  TIMEOUT: "TIMEOUT",
  JS_EXECUTION_ERROR: "JS_EXECUTION_ERROR",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CSP_BLOCKED: "CSP_BLOCKED",
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // -- 传输层（4 类）--
  NATIVE_MESSAGING_ERROR: "NATIVE_MESSAGING_ERROR",
  EXTENSION_NOT_CONNECTED: "EXTENSION_NOT_CONNECTED",
  INVALID_PARAMS: "INVALID_PARAMS",
  UNKNOWN_ACTION: "UNKNOWN_ACTION",

  // -- 组件 / 框架（2 类，@since 0.4.0）--
  /** 目标元素属于框架托管的受控组件（如 Element Plus datetime-range picker），
   *  不能用普通 DOM 原语（fill/type）安全提交值；需换用 vortex_dom_commit。 */
  UNSUPPORTED_TARGET: "UNSUPPORTED_TARGET",
  /** vortex_dom_commit 的 driver 在流程中途失败（picker 打不开、日期格找不到、校验不一致等）。
   *  context.extras 会带 stage 字段标识失败阶段。*/
  COMMIT_FAILED: "COMMIT_FAILED",

  // -- L2 Action layer (added in PR #2) --
  /** Actionability: element detached from DOM */
  NOT_ATTACHED: "NOT_ATTACHED",
  /** Actionability: display:none / visibility:hidden / opacity:0 / 0x0 */
  NOT_VISIBLE: "NOT_VISIBLE",
  /** Actionability: double-RAF sample shows unstable position (animating) */
  NOT_STABLE: "NOT_STABLE",
  /** Actionability: hit-test hit a different element (covered) */
  OBSCURED: "OBSCURED",
  /** Actionability: disabled / aria-disabled / fieldset[disabled] */
  DISABLED: "DISABLED",
  /** Actionability: fill/type target is readonly or non-input */
  NOT_EDITABLE: "NOT_EDITABLE",
  /** Fallback chain exhausted all paths */
  ACTION_FAILED_ALL_PATHS: "ACTION_FAILED_ALL_PATHS",
  /** Drag operation but CDP unavailable */
  DRAG_REQUIRES_CDP: "DRAG_REQUIRES_CDP",
  /** select action: 传入的 value 在 <select> 的 option 里既不匹配 value 属性、
   *  也不匹配可见文本(label)。避免静默选不中却返回 success。
   *  context.extras.available 带可选项清单供 agent 重新选取。*/
  NO_MATCHING_OPTION: "NO_MATCHING_OPTION",
  /** 赋值/驱动类 act 原语(select 多选 / scroll / press 等)dispatch 后回读校验,
   *  发现副作用未真正发生(选项未选中 / 未滚动 / 状态未变)。避免 dispatch 即返回
   *  success 的 silent false-success(2026-06-03 act 原语白盒审计族 A)。*/
  NO_EFFECT: "NO_EFFECT",

  // -- L3 Reasoning（9 类：8 @since 0.6.0 PR #3 + OPEN_SHADOW_DOM @issue #27）--
  /** a11y tree 不可用（CSP / sandboxed page），无法 getFullAXTree。*/
  A11Y_UNAVAILABLE: "A11Y_UNAVAILABLE",
  /** chrome.debugger.attach 失败（缺权限、tab 已关闭等）。*/
  CDP_NOT_ATTACHED: "CDP_NOT_ATTACHED",
  /** ref 关联节点 stale，descriptor 三级消解仍然失败。*/
  STALE_REF: "STALE_REF",
  /** descriptor strict 模式下多匹配。*/
  AMBIGUOUS_DESCRIPTOR: "AMBIGUOUS_DESCRIPTOR",
  /** RefStore 中找不到此 ref。*/
  REF_NOT_FOUND: "REF_NOT_FOUND",
  /** snapshot 已过期（> 5 min）。*/
  SNAPSHOT_EXPIRED: "SNAPSHOT_EXPIRED",
  /** 跨源 iframe，Accessibility.getFullAXTree 拒绝（CDP 已 attach，但 AX tree 不能跨源查询）。*/
  CROSS_ORIGIN_IFRAME: "CROSS_ORIGIN_IFRAME",
  /** closed shadow host，无法穿透。*/
  CLOSED_SHADOW_DOM: "CLOSED_SHADOW_DOM",
  /** 元素在 open shadow root 内：observe 经 querySelectorAllDeep 穿 shadow 发出了 ref，
   *  但 act/fill 的 CSS selector 解析不穿 shadow → 永久不可解析。快速失败给诊断，
   *  而非 NOT_ATTACHED 重试满 timeout（issue #27）。*/
  OPEN_SHADOW_DOM: "OPEN_SHADOW_DOM",

  // -- L4 Task layer（2 类，@since 0.6.0 PR #4）--
  /** target 既不是合法 ref 也不是 valid descriptor 对象。*/
  INVALID_TARGET: "INVALID_TARGET",
  /** action 不在 act 7 enum 内（click/fill/type/select/scroll/hover/drag）。*/
  UNSUPPORTED_ACTION: "UNSUPPORTED_ACTION",
} as const;

export type VtxErrorCode = (typeof VtxErrorCode)[keyof typeof VtxErrorCode];

export interface VtxErrorContext {
  selector?: string;
  index?: number;
  snapshotId?: string;
  tabId?: number;
  frameId?: number;
  /** 兜底字段：存放 handler 场景特有的结构化信息（如遮挡元素 tag、目标 URL、action 名等） */
  extras?: Record<string, unknown>;
}

export interface VtxErrorPayload {
  code: VtxErrorCode;
  message: string;
  hint?: string;
  recoverable?: boolean;
  context?: VtxErrorContext;
}

export type VtxErrorExtra = Omit<VtxErrorPayload, "code" | "message">;

export class VtxError extends Error {
  constructor(
    public readonly code: VtxErrorCode,
    message: string,
    public readonly extra?: VtxErrorExtra,
  ) {
    super(message);
    this.name = "VtxError";
  }

  toJSON(): VtxErrorPayload {
    const payload: VtxErrorPayload = {
      code: this.code,
      message: this.message,
    };
    if (this.extra?.hint !== undefined) payload.hint = this.extra.hint;
    if (this.extra?.recoverable !== undefined) payload.recoverable = this.extra.recoverable;
    if (this.extra?.context !== undefined) payload.context = this.extra.context;
    return payload;
  }

  toString(): string {
    return `VtxError[${this.code}]: ${this.message}`;
  }
}
