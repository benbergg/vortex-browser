/**
 * Description: 跨层不变量——每个 action 的 inner < hub < transport 恒成立。
 */
import { describe, it, expect } from "vitest";
import {
  ACTION_BUDGET_MS,
  DEFAULT_ACTION_BUDGET_MS,
  innerDeadlineFor,
  hubDeadlineFor,
  transportTimeoutFor,
  MAX_INNER_TIMEOUT_MS,
} from "../../src/timeout.js";

// 扫描类不变量必须自带命中数断言，否则空集也会假绿。
describe("超时阶梯次序不变量", () => {
  const actions = [...Object.keys(ACTION_BUDGET_MS), "some.unregistered"];

  it("覆盖到的 action 数量符合预期（防空集假绿）", () => {
    expect(Object.keys(ACTION_BUDGET_MS).length).toBeGreaterThanOrEqual(12);
    expect(actions.length).toBe(Object.keys(ACTION_BUDGET_MS).length + 1);
  });

  it("对每个 action，无论调用方传什么，inner < hub < transport", () => {
    // 含 MAX_INNER_TIMEOUT_MS 边界与越界值：innerDeadlineFor 内部对入参做 min 钳制
    const callerCases = [undefined, 0, 1, 2_000, 30_000, MAX_INNER_TIMEOUT_MS, 120_000];
    for (const action of actions) {
      for (const caller of callerCases) {
        const inner = innerDeadlineFor(action, caller);
        const hub = hubDeadlineFor(action, caller);
        const transport = transportTimeoutFor(hub);
        expect(hub, `${action}/${caller}: hub 未大于 inner`).toBeGreaterThan(inner);
        expect(transport, `${action}/${caller}: transport 未大于 hub`).toBeGreaterThan(hub);
      }
    }
  });

  // 注：innerDeadlineFor 会随调用方 timeout 上移，硬上限只约束表内缺省值本身
  it("缺省预算与所有登记预算都不超过内层硬上限", () => {
    expect(DEFAULT_ACTION_BUDGET_MS).toBeLessThanOrEqual(MAX_INNER_TIMEOUT_MS);
    for (const [action, ms] of Object.entries(ACTION_BUDGET_MS)) {
      expect(ms, `${action} 超上限`).toBeLessThanOrEqual(MAX_INNER_TIMEOUT_MS);
    }
  });
});
