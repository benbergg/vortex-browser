import { describe, it, expect } from "vitest";
import { classifyStep, shouldContinue, summarizeTrace, type StepTrace } from "../src/lib/sequence-run.js";

describe("classifyStep：三态必须可分", () => {
  it("请求失败 → failed（未执行或执行未知，交由 error 说明）", () => {
    expect(classifyStep({ ok: false, error: "[NOT_ATTACHED]: x", fp: {} }).state).toBe("failed");
  });

  it("成功且指纹 matched → executed_verified", () => {
    expect(classifyStep({ ok: true, fp: { drift: null, fingerprint: { action: "fill" } as never } }).state)
      .toBe("executed_verified");
  });

  it("成功但有 drift → executed_unverified，且 drift 原样带出", () => {
    const r = classifyStep({
      ok: true, fp: { drift: { classes: ["value"], details: [] }, fingerprint: { action: "fill" } as never },
    });
    expect(r.state).toBe("executed_unverified");
    expect(r.drift?.classes).toEqual(["value"]);
  });

  it("成功但拿不到指纹 → executed_unverified，不谎称已验证", () => {
    expect(classifyStep({ ok: true, fp: {} }).state).toBe("executed_unverified");
  });
});

describe("shouldContinue", () => {
  it("stop 策略下，非 verified 一律中断", () => {
    expect(shouldContinue("executed_unverified", "stop")).toBe(false);
    expect(shouldContinue("failed", "stop")).toBe(false);
    expect(shouldContinue("executed_verified", "stop")).toBe(true);
  });

  it("continue 策略下失败也继续（对齐 fill_form 的部分成功语义）", () => {
    expect(shouldContinue("failed", "continue")).toBe(true);
  });
});

describe("summarizeTrace", () => {
  it("未跑到的步骤计入 notExecuted，不与 failed 混为一谈", () => {
    const traces: StepTrace[] = [
      { index: 0, action: "click", target: "@a", state: "executed_verified" },
      { index: 1, action: "fill", target: "@b", state: "failed", error: "x" },
      { index: 2, action: "click", target: "@c", state: "not_executed" },
    ];
    expect(summarizeTrace(traces)).toEqual({
      total: 3, verified: 1, unverified: 0, failed: 1, notExecuted: 1,
    });
  });
});
