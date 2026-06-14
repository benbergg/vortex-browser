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
