/**
 * Author: qingwa
 * Description: hub 抛错点的 case-specific hint，覆盖按错误码查表的通用文案。
 */

/**
 * hub↔扩展 的 RPC 超时。内层 deadline 就位后（extension/lib/router.ts），走到这里
 * 意味着扩展侧连自己的超时都没报出来——不是"页面可能没问题"，加大 timeout 没用。
 */
export const RPC_TIMEOUT_HINT =
  "The extension did not answer within the deadline; its own action budget should have " +
  "fired first, so the extension side is likely wedged or was reloaded. " +
  "Call vortex_browser to confirm the extension is connected, then retry. " +
  "Raising the timeout argument will not help.";
