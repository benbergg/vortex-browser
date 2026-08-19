import { describe, it, expect } from "vitest";
import { ACTION_BUDGET_MS } from "@vortex-browser/shared";
import { httpWaiterMsFor } from "../src/http-routes.js";

/**
 * Description: HTTP 面的等待界必须按 action 推导，且严格晚于 hub deadline。
 *
 * 旧值是扁平 35_000：dom.click/observe.snapshot 内层 35s、page.navigate 内层 60s，
 * 于是 HTTP waiter 反而最先 fire，本轮做的四态归因在 CLI 面上永远送不到调用方。
 * 断言写具体数字（> 35_000），不由被测函数自己算。
 */
describe("HTTP waiter 按 action 推导", () => {
  const risky = Object.entries(ACTION_BUDGET_MS).filter(([, ms]) => ms >= 30_000);

  it("覆盖到会被旧扁平 35s 抢先的那批 action（防空集假绿）", () => {
    expect(risky.length).toBeGreaterThanOrEqual(9);
  });

  it.each(risky.map(([a]) => a))("%s 的 waiter 晚于旧扁平 35000", (action) => {
    expect(httpWaiterMsFor(action, undefined)).toBeGreaterThan(35_000);
  });

  it("具体值：dom.click 40000+5000=45000，page.navigate 65000+5000=70000", () => {
    expect(httpWaiterMsFor("dom.click", undefined)).toBe(45_000);
    expect(httpWaiterMsFor("page.navigate", undefined)).toBe(70_000);
  });

  it("调用方 timeout 一并进推导：dom.click timeout=45000 → 60000", () => {
    expect(httpWaiterMsFor("dom.click", 45_000)).toBe(60_000);
  });

  // 未登记 action 走 DEFAULT_ACTION_BUDGET_MS，上面按 ACTION_BUDGET_MS 的遍历覆盖不到
  it("未登记 action 也随 caller 抬高：page.wait 40000 → 55000", () => {
    expect(httpWaiterMsFor("page.wait", 40_000)).toBe(55_000);
  });
});
