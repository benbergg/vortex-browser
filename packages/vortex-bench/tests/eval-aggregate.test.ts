import { describe, it, expect } from "vitest";
import { aggregateEval } from "../src/runner/eval.js";
import type { FixtureScanResult } from "../src/scan-types.js";
import type { CaseMetrics } from "../src/types.js";

/**
 * 评测门 P3.1:aggregateEval 纯聚合——把 A 层(scanFixture 召回)与 B 层(runCase
 * 任务结局)按 tier 合并成分档汇总。纯函数,无需浏览器。
 */
function scan(p: Partial<FixtureScanResult> & { tier: FixtureScanResult["tier"] }): FixtureScanResult {
  return {
    fixture: "f", pattern: "f", path: "/synth/f.html",
    recall: { matched: 0, expected: 0 }, precision: { matchedNoise: 0, emitted: 0 },
    invariants: { inv1: true, inv2: true, inv3: true, inv4: true }, findings: [],
    ...p,
  };
}
function metric(p: Partial<CaseMetrics> & { tier: CaseMetrics["tier"] }): CaseMetrics {
  return {
    case: "c", passed: true, callCount: 1, fallbackToEvaluate: 0,
    observeMissedPopperItems: 0, outputBytes: 0, durationMs: 0, ...p,
  };
}

describe("aggregateEval 分档聚合 (P3.1)", () => {
  it("按 tier 聚合 A 层召回 Σmatched/Σexpected + B 层任务三态", () => {
    const scans: FixtureScanResult[] = [
      scan({ tier: "easy", recall: { matched: 3, expected: 3 }, precision: { matchedNoise: 0, emitted: 5 } }),
      scan({ tier: "medium", recall: { matched: 8, expected: 10 }, precision: { matchedNoise: 1, emitted: 20 } }),
    ];
    const cases: CaseMetrics[] = [
      metric({ tier: "easy", passed: true, fallbackToEvaluate: 0 }), // pass
      metric({ tier: "medium", passed: true, fallbackToEvaluate: 2 }), // pass-degraded
      metric({ tier: "medium", passed: false }), // fail
    ];
    const agg = aggregateEval(scans, cases);
    const easy = agg.find((t) => t.tier === "easy")!;
    const medium = agg.find((t) => t.tier === "medium")!;

    expect(easy.recallMatched).toBe(3);
    expect(easy.recallExpected).toBe(3);
    expect(easy.taskPass).toBe(1);
    expect(easy.fixtureCount).toBe(1);

    expect(medium.recallMatched).toBe(8);
    expect(medium.recallExpected).toBe(10);
    expect(medium.recallNoise).toBe(1);
    expect(medium.taskPass).toBe(0);
    expect(medium.taskDegraded).toBe(1);
    expect(medium.taskFail).toBe(1);
    expect(medium.caseCount).toBe(2);
  });

  it("无 tier 的 case(工具管线类)不计入任何档的任务统计", () => {
    const cases: CaseMetrics[] = [metric({ tier: undefined, passed: true })];
    const agg = aggregateEval([], cases);
    const totalCases = agg.reduce((s, t) => s + t.caseCount, 0);
    expect(totalCases).toBe(0);
  });

  it("缺省 tier 的 scan 归入 medium(与 scanFixture 兜底一致)", () => {
    const agg = aggregateEval([scan({ tier: undefined as any, recall: { matched: 1, expected: 1 } })], []);
    expect(agg.find((t) => t.tier === "medium")!.recallMatched).toBe(1);
  });
});
