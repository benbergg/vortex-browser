import { describe, it, expect } from "vitest";
import { ACTION_BUDGET_MS } from "@vortex-browser/shared";
import { cliAbortMsFor } from "../src/client.js";

/**
 * Description: CLI 的 fetch abort 是阶梯最外一层，必须晚于 HTTP waiter。
 *
 * 旧值是扁平 35_000，与 HTTP waiter 同值、比内层预算还早：CLI 上永远只看得到
 * 通用的 RPC 超时，看不到扩展侧的四态归因。断言写具体数字，不复算被测公式。
 */
describe("CLI abort 按 action 推导", () => {
  const risky = Object.entries(ACTION_BUDGET_MS).filter(([, ms]) => ms >= 30_000);

  it("覆盖到会被旧扁平 35s 抢先的那批 action（防空集假绿）", () => {
    expect(risky.length).toBeGreaterThanOrEqual(9);
  });

  it.each(risky.map(([a]) => a))("%s 的 abort 晚于旧扁平 35000", (action) => {
    expect(cliAbortMsFor(action, undefined)).toBeGreaterThan(35_000);
  });

  it("具体值：dom.click 50000，page.navigate 75000", () => {
    expect(cliAbortMsFor("dom.click", undefined)).toBe(50_000);
    expect(cliAbortMsFor("page.navigate", undefined)).toBe(75_000);
  });
});
