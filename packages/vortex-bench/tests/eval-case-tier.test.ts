import { describe, it, expect } from "vitest";
import type { CaseDefinition, CaseMetrics } from "../src/types.js";

/**
 * 评测门 P2.1:B 层 case 绑定难度档 + 快照,使 eval 能按 tier 聚合任务通过率,
 * 并把 case 关联到对应 synth 快照(playgroundPath 指向 /synth/<snapshot>.html)。
 */
describe("eval B 层 tier/snapshot 字段 (P2.1)", () => {
  it("CaseDefinition 接受 tier + snapshot", () => {
    const c: CaseDefinition = {
      name: "x",
      playgroundPath: "/synth/x.html",
      tier: "medium",
      snapshot: "x",
      run: async () => {},
    };
    expect(c.tier).toBe("medium");
    expect(c.snapshot).toBe("x");
  });

  it("CaseMetrics 接受 tier(供 eval 报告分档聚合)", () => {
    const m: Partial<CaseMetrics> = { case: "x", tier: "hard" };
    expect(m.tier).toBe("hard");
  });
});
