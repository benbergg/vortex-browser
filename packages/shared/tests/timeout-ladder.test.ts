/**
 * Author: qingwa
 * Description: Verifies the inner/hub/transport timeout ladder stays strictly increasing.
 */
import { describe, it, expect } from "vitest";
import {
  ACTION_BUDGET_MS,
  clampHubTimeout,
  DEFAULT_ACTION_BUDGET_MS,
  actionBudgetMs,
  hubDeadlineFor,
  innerDeadlineFor,
  MAX_HUB_TIMEOUT_MS,
  MAX_INNER_TIMEOUT_MS,
  TIMEOUT_LADDER_STEP_MS,
  timeoutLadder,
  transportTimeoutFor,
} from "../src/timeout.js";

/**
 * 一次调用在三层各有一个 deadline：extension handler 内层预算 < hub pending < 客户端传输。
 * 必须严格递增，否则外层先 fire，调用方拿到的是"没人应答"而不是 handler 说得清的原因。
 *
 * 历史缺陷：三层各写各的常量（hub 30s / extension [1,60000] / MCP caller+5s），且
 * VtxRequest 根本没有 timeout 字段——调用方设 45s 会被 hub 静默砍在 30s，live 复现的
 * 错误是 hub 的 "Request js.evaluateAsync timed out"。本文件是这三层的唯一真源。
 */
describe("timeoutLadder", () => {
  const DEFAULT_HUB = 30_000;

  it("调用方指定 timeout 时 inner < hub < transport 严格递增", () => {
    const l = timeoutLadder(45_000, DEFAULT_HUB);
    expect(l.inner).toBe(45_000);
    expect(l.hub).toBeGreaterThan(l.inner as number);
    expect(l.transport).toBeGreaterThan(l.hub);
  });

  it("调用方要的大 timeout 不被 hub 默认值截断", () => {
    const l = timeoutLadder(45_000, DEFAULT_HUB);
    expect(l.hub).toBeGreaterThanOrEqual(45_000);
    expect(l.hub).toBeGreaterThan(DEFAULT_HUB);
  });

  it("未指定 timeout 时无内层预算，hub 用默认值", () => {
    const l = timeoutLadder(undefined, DEFAULT_HUB);
    expect(l.inner).toBeUndefined();
    expect(l.hub).toBe(DEFAULT_HUB);
  });

  it("未指定 timeout 时 transport 仍严格大于 hub，两者不同 deadline 竞 race", () => {
    const l = timeoutLadder(undefined, DEFAULT_HUB);
    expect(l.transport).toBeGreaterThan(l.hub);
  });

  it("caller=0 视为显式短预算，不回退默认", () => {
    const l = timeoutLadder(0, DEFAULT_HUB);
    expect(l.inner).toBe(0);
    expect(l.hub).toBe(TIMEOUT_LADDER_STEP_MS);
  });

  it("transportTimeoutFor 与 ladder 用同一公式", () => {
    const l = timeoutLadder(1_500, DEFAULT_HUB);
    expect(transportTimeoutFor(l.hub)).toBe(l.transport);
  });

  it("每层 margin 至少 3s，覆盖 NM 回程与 handler teardown", () => {
    expect(TIMEOUT_LADDER_STEP_MS).toBeGreaterThanOrEqual(3_000);
  });
});

describe("clampHubTimeout", () => {
  it("缺省时回退到 hub 自身默认", () => {
    expect(clampHubTimeout(undefined, 30_000)).toBe(30_000);
  });

  it("合法值原样透传", () => {
    expect(clampHubTimeout(50_000, 30_000)).toBe(50_000);
  });

  it("超上限被钳，防客户端把 pending 钉死", () => {
    expect(clampHubTimeout(MAX_HUB_TIMEOUT_MS + 1, 30_000)).toBe(MAX_HUB_TIMEOUT_MS);
  });

  it("负数与非有限值回退到默认而非崩", () => {
    expect(clampHubTimeout(-1, 30_000)).toBe(30_000);
    expect(clampHubTimeout(Number.NaN, 30_000)).toBe(30_000);
    expect(clampHubTimeout(Number.POSITIVE_INFINITY, 30_000)).toBe(30_000);
  });

  it("0 视为非法，回退默认（hub 侧 0 会让 pending 立刻自杀）", () => {
    expect(clampHubTimeout(0, 30_000)).toBe(30_000);
  });
});

describe("per-action 内层预算表", () => {
  it("未登记的 action 落到缺省预算", () => {
    expect(actionBudgetMs("some.unregistered")).toBe(DEFAULT_ACTION_BUDGET_MS);
  });

  it("登记的 action 用自己的预算", () => {
    expect(actionBudgetMs("page.navigate")).toBe(60_000);
    expect(actionBudgetMs("content.getText")).toBe(20_000);
  });

  // 零回归锁：预算不得低于 30 天「未传 timeout 的成功调用」max（spec 第 8 节）
  it("🔴 REGRESSION: 每个登记预算都覆盖其实测成功耗时上限", () => {
    const observedMaxMs: Record<string, number> = {
      "page.navigate": 69_861,
      "observe.snapshot": 27_999,
      "dom.click": 26_114,
      "mouse.click": 22_145,
      "capture.screenshot": 20_870,
      "content.getText": 10_689,
      "page.waitForExpression": 10_046,
    };
    for (const [action, observed] of Object.entries(observedMaxMs)) {
      const budget = actionBudgetMs(action);
      // navigate 的 69861 单点超过内层硬上限，按上限封顶（P99 为 27028，覆盖充分）
      const expectedFloor = Math.min(observed, MAX_INNER_TIMEOUT_MS);
      expect(budget, `${action} 预算 ${budget} 低于实测上限 ${expectedFloor}`)
        .toBeGreaterThanOrEqual(expectedFloor);
    }
  });

  it("任何预算都不超过内层硬上限", () => {
    for (const [action, ms] of Object.entries(ACTION_BUDGET_MS)) {
      expect(ms, `${action} 超出 MAX_INNER_TIMEOUT_MS`).toBeLessThanOrEqual(MAX_INNER_TIMEOUT_MS);
    }
  });

  it("调用方的小 timeout 不压低任何一层", () => {
    // act 传 5000 不得把 hub 挤到 10s——act 成功 P99 是 25.5s
    expect(innerDeadlineFor("dom.click", 5_000)).toBe(actionBudgetMs("dom.click"));
    expect(hubDeadlineFor("dom.click", 5_000)).toBe(
      actionBudgetMs("dom.click") + TIMEOUT_LADDER_STEP_MS,
    );
  });

  it("🔴 REGRESSION: 自管超时的 handler 传大 timeout 时 inner 随之上移", () => {
    // js.evaluate 自己用 args.timeout 作脚本预算，30 天内成功样本 max 42545ms。
    // inner 若停在缺省 30s，会砍掉 evaluate(timeout:45000) 这类合法调用。
    expect(innerDeadlineFor("js.evaluate", 45_000)).toBe(45_000 + TIMEOUT_LADDER_STEP_MS);
    expect(hubDeadlineFor("js.evaluate", 45_000)).toBeGreaterThan(
      innerDeadlineFor("js.evaluate", 45_000),
    );
  });

  it("调用方未指定时 inner = 该 action 预算，hub 再加一档", () => {
    expect(innerDeadlineFor("mouse.click", undefined)).toBe(actionBudgetMs("mouse.click"));
    expect(hubDeadlineFor("mouse.click", undefined)).toBe(
      actionBudgetMs("mouse.click") + TIMEOUT_LADDER_STEP_MS,
    );
  });
});
