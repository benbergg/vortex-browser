import { describe, it, expect } from "vitest";
import { runSequence, type SequenceStepInput } from "../src/lib/sequence-run.js";

const three: SequenceStepInput[] = [
  { action: "click", target: "@a" },
  { action: "fill", target: "@b", value: "x" },
  { action: "click", target: "@c" },
];

const clicked = { success: true, effect: {
  domMutations: 1, networkRequests: 0, urlChanged: false,
  focusChanged: false, ariaChanged: false, userFeedback: "none" as const,
} };

describe("runSequence 编排", () => {
  it("stop 策略：中途自证 unconfirmed 后剩余步骤保持 not_executed", async () => {
    const out = await runSequence(three, "stop", async (step, i) =>
      i === 1
        ? { ok: true, result: { success: true, value: "REVERTED" } }
        : { ok: true, result: clicked });
    expect(out.steps.map((s) => s.state))
      .toEqual(["executed_verified", "executed_unverified", "not_executed"]);
    expect(out.steps[1].effect).toBe("unconfirmed");
    expect(out.summary.notExecuted).toBe(1);
  });

  it("continue 策略：失败步不阻断后续", async () => {
    const out = await runSequence(three, "continue", async (step, i) =>
      i === 1
        ? { ok: false, error: "boom" }
        : { ok: true, result: step.action === "fill" ? { success: true, value: "x" } : clicked });
    expect(out.summary).toEqual({ total: 3, verified: 2, unverified: 0, failed: 1, notExecuted: 0 });
    expect(out.steps[1].error).toBe("boom");
  });

  it("全部自证通过时无 not_executed", async () => {
    const out = await runSequence(three, "stop", async (step) =>
      ({ ok: true, result: step.action === "fill" ? { success: true, value: "x" } : clicked }));
    expect(out.summary.verified).toBe(3);
    expect(out.summary.notExecuted).toBe(0);
  });

  it("send 抛异常 → 该步 failed，不让整个调用崩掉", async () => {
    const out = await runSequence(three, "stop", async (step, i) => {
      if (i === 0) throw new Error("resolve failed");
      return { ok: true, result: clicked };
    });
    expect(out.steps[0].state).toBe("failed");
    expect(out.steps[0].error).toContain("resolve failed");
    expect(out.steps[1].state).toBe("not_executed");
  });

  it("空 steps → 全零汇总，不抛错", async () => {
    const out = await runSequence([], "stop", async () => ({ ok: true }));
    expect(out.summary).toEqual({ total: 0, verified: 0, unverified: 0, failed: 0, notExecuted: 0 });
  });
});
