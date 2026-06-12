import { describe, it, expect } from "vitest";
import { liftWaitForRefToTarget } from "../src/lib/wait-for-ref.js";

/**
 * BUG-002 (N0063): wait_for(mode=element) 的 @ref 经 value 字段传入(非 target),
 * 绕过 server.ts 的 target→{index,snapshotId} 翻译链 → 历史上直接 throw
 * "@ref form not supported here"。liftWaitForRefToTarget 在翻译前把 @ref 形式的
 * value 抬成 target,复用同一条翻译+STALE 校验。CSS selector / 其它 mode / 其它工具
 * 保持原样。
 */
describe("liftWaitForRefToTarget (BUG-002 N0063)", () => {
  it("wait_for mode=element + @ref value → 抬成 target,删 value", () => {
    const params: Record<string, unknown> = { mode: "element", value: "@be58:e13", timeout: 3000 };
    liftWaitForRefToTarget("vortex_wait_for", params);
    expect(params.target).toBe("@be58:e13");
    expect("value" in params).toBe(false);
    expect(params.timeout).toBe(3000);
  });

  it("wait_for mode=element + CSS selector value → 保持 value 不动(走 dispatch selector 透传)", () => {
    const params: Record<string, unknown> = { mode: "element", value: ".btn" };
    liftWaitForRefToTarget("vortex_wait_for", params);
    expect(params.value).toBe(".btn");
    expect("target" in params).toBe(false);
  });

  it("wait_for mode=idle + @ref-looking value → 不动(idle 的 value 是 network/dom 语义)", () => {
    const params: Record<string, unknown> = { mode: "idle", value: "network" };
    liftWaitForRefToTarget("vortex_wait_for", params);
    expect(params.value).toBe("network");
    expect("target" in params).toBe(false);
  });

  it("其它工具(含 @ 形 value)→ 不动", () => {
    const params: Record<string, unknown> = { mode: "element", value: "@be58:e1" };
    liftWaitForRefToTarget("vortex_act", params);
    expect(params.value).toBe("@be58:e1");
    expect("target" in params).toBe(false);
  });
});
