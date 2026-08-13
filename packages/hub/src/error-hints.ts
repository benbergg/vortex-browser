/**
 * Author: qingwa
 * Description: hub 抛错点的 case-specific hint，覆盖按错误码查表的通用文案。
 */

/**
 * hub↔扩展 的 RPC 超时。表里的 TIMEOUT hint 是写给页面 actionability 超时的，
 * 会让 agent 去等页面 idle —— 通道超时时页面稳不稳定无关（2026-08-13 日志 3/60 次）。
 */
export const RPC_TIMEOUT_HINT =
  "The hub-to-extension request exceeded its deadline; the page itself may be fine. " +
  "Retry with a larger timeout argument, or call vortex_observe to check the extension is still responsive. " +
  "Waiting for the page to go idle does not help here.";
