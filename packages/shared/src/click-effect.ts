/**
 * Description: Shared click-effect user-feedback signal (universal silent-fail enhancement).
 *   classifyFeedback classifies a click outcome into a coarse feedback bucket so
 *   agents can distinguish "page showed a toast/dialog" vs "pure DOM mutation noise"
 *   vs "no feedback at all". The 3-arg signature (dialogHit, toastHit, domMutations)
 *   is the single source of truth — corrected from the V1 2-arg/3-arg mismatch.
 *   Priority: dialog > toast > mutation > none.
 */
export type UserFeedback = "none" | "toast" | "dialog" | "mutation";

export const TOAST_SELECTORS = [
  ".el-message",
  ".el-notification",
  ".ant-message",
  ".ant-notification",
  ".arco-message",
  ".bn-msg",
  ".bn-toast",
  ".toast",
  "[role='alert']",
  "[role='status']",
] as const;

export const DIALOG_SELECTORS = [
  ".el-dialog__wrapper",
  ".el-drawer__open",
  ".ant-modal",
  ".ant-drawer",
  ".arco-modal",
  ".bn-drawer",
  ".bn-modal",
  ".MuiDialog-root",
  ".MuiDrawer-root",
  "[role='dialog']",
  "[role='alertdialog']",
  // 原生 Popover API:showPopover 把元素移入 top-layer,无 DOM mutation/属性变化,
  // 框架 dialog/toast 类也不匹配 → userFeedback 误报 "none"(agent 误判点击无反馈)。
  // :popover-open 仅匹配带 popover 属性的打开态元素(GitHub/shadcn 等渐广),精确不误伤
  // flatpickr/antd 等非原生浮层。该伪类在不支持的浏览器抛 SyntaxError,collectFeedback
  // 逐选择器 try 包裹兜底(2026-06-22 flatpickr/Popover API dogfood)。
  ":popover-open",
] as const;

export function classifyFeedback(
  dialogHit: boolean,
  toastHit: boolean,
  domMutations: number,
): UserFeedback {
  if (dialogHit) return "dialog";
  if (toastHit) return "toast";
  if (domMutations > 0) return "mutation";
  return "none";
}
