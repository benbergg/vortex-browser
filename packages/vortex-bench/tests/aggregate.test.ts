// Pin the aggregate() contract: median for numerics, majority-pass for the
// boolean, deterministic failure-reason / failure-class selection. The
// runner now collapses N runs through this function, so any silent drift
// (e.g. switching to mean, or to first-fail-wins) would re-introduce the
// flake sensitivity --repeats was added to remove.

import { describe, it, expect } from "vitest";
import { aggregate, median } from "../src/runner/aggregate.js";
import type { CaseMetrics } from "../src/types.js";

function r(overrides: Partial<CaseMetrics>): CaseMetrics {
  return {
    case: "demo",
    passed: true,
    callCount: 0,
    fallbackToEvaluate: 0,
    observeMissedPopperItems: 0,
    outputBytes: 0,
    durationMs: 0,
    ...overrides,
  };
}

describe("median()", () => {
  it("empty array → 0", () => {
    expect(median([])).toBe(0);
  });
  it("single value → itself", () => {
    expect(median([42])).toBe(42);
  });
  it("odd length → middle", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("even length → mean of middle pair", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("does not mutate input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("aggregate()", () => {
  it("throws on empty input", () => {
    expect(() => aggregate([])).toThrow(/non-empty/);
  });

  it("repeats=1 returns the run unchanged (no aggregation fields)", () => {
    const single = r({ callCount: 5, passed: true });
    const out = aggregate([single]);
    expect(out).toBe(single);
    expect(out.repeats).toBeUndefined();
    expect(out.passRate).toBeUndefined();
  });

  it("all-pass → passed=true, passRate=1, repeats=N", () => {
    const runs = [r({ passed: true }), r({ passed: true }), r({ passed: true })];
    const out = aggregate(runs);
    expect(out.passed).toBe(true);
    expect(out.passRate).toBe(1);
    expect(out.repeats).toBe(3);
    expect(out.failureReason).toBeUndefined();
    expect(out.failureClass).toBeUndefined();
  });

  it("all-fail → passed=false, passRate=0", () => {
    const runs = [
      r({ passed: false, failureReason: "boom-1", failureClass: "tool_error" }),
      r({ passed: false, failureReason: "boom-2", failureClass: "tool_error" }),
    ];
    const out = aggregate(runs);
    expect(out.passed).toBe(false);
    expect(out.passRate).toBe(0);
    expect(out.repeats).toBe(2);
  });

  it("2-of-3 pass → passed=true (majority), passRate=0.667", () => {
    const runs = [
      r({ passed: true }),
      r({ passed: true }),
      r({ passed: false, failureReason: "single flake" }),
    ];
    const out = aggregate(runs);
    expect(out.passed).toBe(true);
    expect(out.passRate).toBeCloseTo(2 / 3, 5);
    // failureReason / failureClass not exposed when aggregated `passed=true`
    expect(out.failureReason).toBeUndefined();
  });

  it("1-of-3 pass → passed=false (minority), failure info populated", () => {
    const runs = [
      r({ passed: false, failureReason: "first fail", failureClass: "assertion_failure" }),
      r({ passed: true }),
      r({ passed: false, failureReason: "third fail", failureClass: "assertion_failure" }),
    ];
    const out = aggregate(runs);
    expect(out.passed).toBe(false);
    expect(out.passRate).toBeCloseTo(1 / 3, 5);
    expect(out.failureReason).toBe("first fail"); // first failing run wins
    expect(out.failureClass).toBe("assertion_failure");
  });

  it("2/4 split → tie goes to pass (passRate=0.5 >= 0.5)", () => {
    const runs = [
      r({ passed: true }),
      r({ passed: true }),
      r({ passed: false, failureReason: "x" }),
      r({ passed: false, failureReason: "y" }),
    ];
    const out = aggregate(runs);
    expect(out.passed).toBe(true);
    expect(out.passRate).toBe(0.5);
  });

  it("numeric medians: odd N", () => {
    const runs = [
      r({ callCount: 10, outputBytes: 1000, durationMs: 500 }),
      r({ callCount: 12, outputBytes: 800, durationMs: 600 }),
      r({ callCount: 11, outputBytes: 1100, durationMs: 550 }),
    ];
    const out = aggregate(runs);
    expect(out.callCount).toBe(11);
    expect(out.outputBytes).toBe(1000);
    expect(out.durationMs).toBe(550);
  });

  it("numeric medians: even N (mean of middle pair)", () => {
    const runs = [
      r({ callCount: 10 }),
      r({ callCount: 12 }),
      r({ callCount: 14 }),
      r({ callCount: 16 }),
    ];
    const out = aggregate(runs);
    expect(out.callCount).toBe(13);
  });

  it("outputBytesByTool: per-tool median, missing tool contributes 0", () => {
    const runs = [
      r({ outputBytesByTool: { vortex_observe: 500, vortex_act: 100 } }),
      r({ outputBytesByTool: { vortex_observe: 700 } }), // no vortex_act
      r({ outputBytesByTool: { vortex_observe: 600, vortex_act: 200 } }),
    ];
    const out = aggregate(runs);
    expect(out.outputBytesByTool).toEqual({
      vortex_observe: 600, // median(500, 700, 600)
      vortex_act: 100, // median(100, 0, 200)
    });
  });

  it("customMetrics: per-key median, missing key contributes 0", () => {
    const runs = [
      r({ customMetrics: { latencyP50: 80, tokenBaseline: 1000 } }),
      r({ customMetrics: { latencyP50: 100 } }),
      r({ customMetrics: { latencyP50: 90, tokenBaseline: 1200 } }),
    ];
    const out = aggregate(runs);
    expect(out.customMetrics).toEqual({
      latencyP50: 90,
      tokenBaseline: 1000, // median(1000, 0, 1200)
    });
  });

  it("failureClass: mode wins when classes mix", () => {
    const runs = [
      r({ passed: false, failureReason: "env-1", failureClass: "env_failure" }),
      r({ passed: false, failureReason: "env-2", failureClass: "env_failure" }),
      r({ passed: false, failureReason: "assert", failureClass: "assertion_failure" }),
    ];
    const out = aggregate(runs);
    expect(out.failureClass).toBe("env_failure"); // 2 vs 1
    expect(out.failureReason).toBe("env-1");
  });

  it("failureReason only set when aggregated result is failed", () => {
    // 2 pass + 1 fail → majority pass → no failureReason exposure
    const runs = [
      r({ passed: false, failureReason: "flake!" }),
      r({ passed: true }),
      r({ passed: true }),
    ];
    const out = aggregate(runs);
    expect(out.passed).toBe(true);
    expect(out.failureReason).toBeUndefined();
    expect(out.failureClass).toBeUndefined();
  });

  it("propagates case name from first run", () => {
    const runs = [r({ case: "el-dropdown", passed: true }), r({ case: "el-dropdown", passed: false })];
    const out = aggregate(runs);
    expect(out.case).toBe("el-dropdown");
  });
});
