import { describe, it, expect } from "vitest";
import { ACTION_BUDGET_MS, hubDeadlineFor, innerDeadlineFor } from "@vortex-browser/shared";
import { httpWaiterMsFor } from "../src/http-routes.js";

/**
 * Description: HTTP/CLI 路径不写 timeoutMs，hub 只能走缺省兜底；兜底若不看
 * params.timeout，调用方传大 timeout 时 hub 会重新抢在内层之前。
 *
 * 复现算例：page.wait timeout=40000 → inner 45000、handler 自身界 40500，
 * 兜底若按 undefined 推导只有 35000，hub 先 fire，语义化归因全丢。
 */
describe("hub 缺省兜底必须把调用方 timeout 算进去", () => {
  const actions = Object.keys(ACTION_BUDGET_MS);
  const callerTimeouts = [1, 20_000, 40_000, 60_000];

  it("覆盖面非空（防空集假绿）", () => {
    expect(actions.length).toBeGreaterThanOrEqual(12);
    expect(callerTimeouts.length).toBe(4);
  });

  it.each(actions)("%s：任一合法 caller timeout 下兜底都晚于内层预算", (action) => {
    for (const t of callerTimeouts) {
      expect(
        hubDeadlineFor(action, t),
        `${action} caller=${t}: hub 会抢在内层之前`,
      ).toBeGreaterThan(innerDeadlineFor(action, t));
    }
  });

  it("HTTP waiter 也随 caller timeout 抬高：page.wait 40000 → inner 45000 / hub 50000 / waiter 55000", () => {
    expect(httpWaiterMsFor("page.wait", 40_000)).toBe(55_000);
  });
});
