/**
 * Description: 超时归因用的有界探活——区分「页面主线程卡死」与「探针本身失败」。
 */
import type { TimeoutLiveness } from "@vortex-browser/shared";
import { raceTimeout, TIMED_OUT } from "./race-timeout.js";
import { pageQuery } from "../adapter/native.js";

// 内层界到点后才跑的归因动作,调用方在等错误消息,等不起 actionability.ts:24 的 2000ms。
const PROBE_BUDGET_MS = 300;

// 与 hint/recoverable 表同源，扩态时两侧一起编译失败
export type Liveness = TimeoutLiveness;

/**
 * 打一个极短空脚本探页面主线程死活；budgetMs 覆盖 tabs.get+探针全程，超时一律
 * page-unresponsive，探针失败不谎报 page-alive。frameId 必须与被超时的动作同一个，
 * 否则 OOPIF 卡死会被主 frame 的秒答盖成 page-alive。
 */
export async function probeLiveness(
  tabId: number | undefined,
  budgetMs: number = PROBE_BUDGET_MS,
  frameId?: number,
): Promise<Liveness> {
  if (tabId == null) return "page-alive";

  const attempt = (async (): Promise<Liveness> => {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return "tab-gone";
    }
    try {
      await pageQuery(tabId, frameId, () => 1);
      return "page-alive";
    } catch {
      return "probe-failed";
    }
  })();

  const result = await raceTimeout(attempt, budgetMs);
  return result === TIMED_OUT ? "page-unresponsive" : result;
}
