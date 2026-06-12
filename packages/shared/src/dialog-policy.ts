// MAIN-world dialog 应答策略的共享类型与常量(单一真源)。
// 注意:override(content-main.ts)与动作 handler 注入 func 因 executeScript
// 注入丢模块作用域,运行期逻辑须各自内联;此文件只导出编译期可共享的类型/常量。

/** dialog 应答全局挂在 MAIN world 的这个键上。 */
export const DIALOG_POLICY_KEY = "__vortexDialogPolicy" as const;

/** 动作返回后保持抑制的 grace 窗(ms),覆盖 setTimeout 异步弹框,避免冻结后续动作。 */
export const DIALOG_GRACE_MS = 1000;

export type DialogKind = "alert" | "confirm" | "prompt";
export type DialogAnswer = "accept" | "dismiss";

export interface VortexDialogPolicy {
  /** 动作执行期间为 true(无时限);动作结束置 false。 */
  armed: boolean;
  /** 动作结束后的 grace 截止时间戳(ms);armed===false 时靠它判定是否仍抑制。 */
  until: number;
  /** confirm→accept返true/dismiss返false;prompt→accept返promptText/默认值,dismiss返null;alert无差异。 */
  answer: DialogAnswer;
  /** prompt 应答文本;null 表示未指定(prompt accept 时回退页面默认值)。 */
  promptText: string | null;
  /** 本次动作期间被抑制的 dialog 记录,供 handler 组装 dialogHandled。 */
  captured: Array<{ type: DialogKind; message: string }>;
}
