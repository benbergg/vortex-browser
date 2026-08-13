import { describe, it, expect } from "vitest";
import { classifyStep, shouldContinue, summarizeTrace, verifyStepEffect, type StepTrace } from "../src/lib/sequence-run.js";

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

describe("verifyStepEffect：单步是否生效", () => {
  it("fill 回读值等于入参 → confirmed", () => {
    expect(verifyStepEffect("fill", "a@b.com", { success: true, value: "a@b.com" }))
      .toBe("confirmed");
  });

  it("fill 被受控组件改回 → unconfirmed（这是静默假成功的拦截点）", () => {
    expect(verifyStepEffect("fill", "typed", { success: true, value: "REVERTED" }))
      .toBe("unconfirmed");
  });

  it("fill 没有回读值 → unknown，不把「不知道」说成「没生效」", () => {
    expect(verifyStepEffect("fill", "x", { success: true })).toBe("unknown");
  });

  it("超 500 的入参按同样规则截断后再比 → confirmed", () => {
    const long = "字".repeat(1200);
    const back = "字".repeat(500) + "…";
    expect(verifyStepEffect("type", long, { success: true, value: back })).toBe("confirmed");
  });

  it("select 回读值与入参不等 → unknown（option value 与可见文本本就可能不同）", () => {
    expect(verifyStepEffect("select", "上海", { success: true, value: "sh" })).toBe("unknown");
  });

  it("scroll moved:false → unconfirmed", () => {
    expect(verifyStepEffect("scroll", undefined, { success: true, moved: false }))
      .toBe("unconfirmed");
  });

  it("click 有任一副作用信号 → confirmed", () => {
    expect(verifyStepEffect("click", undefined, {
      success: true,
      effect: { domMutations: 3, networkRequests: 0, urlChanged: false,
                focusChanged: false, ariaChanged: false, userFeedback: "none" },
    })).toBe("confirmed");
  });

  it("click 未开 observeEffect → unknown", () => {
    expect(verifyStepEffect("click", undefined, { success: true })).toBe("unknown");
  });
});

describe("classifyStep 接入自证", () => {
  it("无 drift 但自证 confirmed → executed_verified", () => {
    expect(classifyStep({ ok: true, fp: {}, effect: "confirmed" }).state)
      .toBe("executed_verified");
  });

  it("无 drift 且自证 unconfirmed → executed_unverified，effect 原样带出", () => {
    const r = classifyStep({ ok: true, fp: {}, effect: "unconfirmed" });
    expect(r.state).toBe("executed_unverified");
    expect(r.effect).toBe("unconfirmed");
  });
});
