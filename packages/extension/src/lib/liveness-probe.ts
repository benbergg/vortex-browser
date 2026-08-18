/**
 * Author: qingwa
 * Description: 超时归因用的有界探活——区分「页面主线程卡死」与「探针本身失败」。
 */
import { PageQueryTimeoutError, pageQuery } from "../adapter/native.js";

// 内层界已到点后才跑的归因动作，调用方在等错误消息，不能再等 waitActionable 级的
// 2000ms（action/actionability.ts PROBE_TIMEOUT_MS），故取更短的 300ms。
const PROBE_BUDGET_MS = 300;

export type Liveness = "page-alive" | "page-unresponsive" | "probe-failed" | "tab-gone";

/**
 * 往目标 tab 打一个极短的空脚本探页面主线程死活，复用 pageQuery 的有界 timeoutMs
 * 机制（native.ts），不再造第四个同族有界 executeScript。
 *
 * executeScript 快速 reject（无 host 权限 / chrome:// / frame 已移除等）不等于
 * 页面存活，如实报 probe-failed，不得编造未验证过的 page-alive。
 */
export async function probeLiveness(
  tabId: number | undefined,
  budgetMs: number = PROBE_BUDGET_MS,
): Promise<Liveness> {
  if (tabId == null) return "page-alive";
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return "tab-gone";
  }
  try {
    await pageQuery(tabId, undefined, () => 1, [], budgetMs);
    return "page-alive";
  } catch (err) {
    if (err instanceof PageQueryTimeoutError) return "page-unresponsive";
    return "probe-failed";
  }
}
