// Aggregate N runs of the same case into a single CaseMetrics with
// median-of-N for numerics and majority-pass for the boolean. Used by
// `vortex-bench run --repeats N` to dampen single-shot flakiness without
// hiding genuinely failing cases.

import type { CaseMetrics } from "../types.js";

/** Pure median: sorted-ascending, average of middle pair on even length. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 只保留已定义的值（undefined ≠ 0）。 */
function definedValues(values: (number | undefined)[]): number[] {
  return values.filter((v): v is number => v !== undefined);
}

/**
 * Aggregate N runs of the same case. Caller guarantees `runs.length >= 1`
 * and that every run is for the same case (same `case` field).
 *
 * Policy:
 * - `passed = passRate >= 0.5` (majority wins; ties go to pass).
 * - Numerics use median across all N runs (resists one slow / one buffered run).
 * - `outputBytesByTool` and `customMetrics` are merged per-key; missing keys
 *   contribute a 0 to the median calculation so a tool that fires in only some
 *   runs doesn't get its median artificially inflated.
 * - `failureReason` is the reason from the FIRST failing run (deterministic,
 *   matches what an operator would see chronologically).
 * - `failureClass` is the most common class among failing runs (mode);
 *   ties broken by first-seen order.
 * - When `runs.length === 1`, returns the run unchanged (no `repeats` /
 *   `passRate` fields set) so reports byte-match single-shot history.
 */
export function aggregate(runs: CaseMetrics[]): CaseMetrics {
  if (runs.length === 0) {
    throw new Error("aggregate: runs must be non-empty");
  }
  if (runs.length === 1) return runs[0];

  const n = runs.length;
  const passedCount = runs.filter((r) => r.passed).length;
  const passRate = passedCount / n;
  const passed = passRate >= 0.5;

  const m: CaseMetrics = {
    case: runs[0].case,
    passed,
    callCount: median(runs.map((r) => r.callCount)),
    fallbackToEvaluate: median(runs.map((r) => r.fallbackToEvaluate)),
    observeMissedPopperItems: median(runs.map((r) => r.observeMissedPopperItems)),
    outputBytes: median(runs.map((r) => r.outputBytes)),
    durationMs: median(runs.map((r) => r.durationMs)),
    repeats: n,
    passRate,
  };

  const byToolKeys = new Set<string>();
  for (const r of runs) {
    if (r.outputBytesByTool) for (const k of Object.keys(r.outputBytesByTool)) byToolKeys.add(k);
  }
  if (byToolKeys.size > 0) {
    const byTool: Record<string, number> = {};
    for (const k of byToolKeys) {
      byTool[k] = median(runs.map((r) => r.outputBytesByTool?.[k] ?? 0));
    }
    m.outputBytesByTool = byTool;
  }

  const customKeys = new Set<string>();
  for (const r of runs) {
    if (r.customMetrics) for (const k of Object.keys(r.customMetrics)) customKeys.add(k);
  }
  if (customKeys.size > 0) {
    const custom: Record<string, number> = {};
    for (const k of customKeys) {
      custom[k] = median(runs.map((r) => r.customMetrics?.[k] ?? 0));
    }
    m.customMetrics = custom;
  }

  // 契约指标（assertionCount / hintPresentRate / refReuseRate）：N-run 聚合时保留，
  // 只对**已定义**的 run 取 median——缺失 ≠ 0（比率指标的 0 与"本次无该类调用"语义不同，
  // 补 0 会把"没测到"误报成"测出来是 0"）。全部缺失时不写入，保持报告形状稳定。
  const assertionCounts = definedValues(runs.map((r) => r.assertionCount));
  if (assertionCounts.length > 0) m.assertionCount = median(assertionCounts);
  const hintRates = definedValues(runs.map((r) => r.hintPresentRate));
  if (hintRates.length > 0) m.hintPresentRate = median(hintRates);
  const refRates = definedValues(runs.map((r) => r.refReuseRate));
  if (refRates.length > 0) m.refReuseRate = median(refRates);

  if (!passed) {
    const failures = runs.filter((r) => !r.passed);
    const firstFailReason = failures.find((r) => r.failureReason)?.failureReason;
    if (firstFailReason) m.failureReason = firstFailReason;

    const classCounts = new Map<NonNullable<CaseMetrics["failureClass"]>, number>();
    for (const f of failures) {
      if (f.failureClass) {
        classCounts.set(f.failureClass, (classCounts.get(f.failureClass) ?? 0) + 1);
      }
    }
    let modalClass: CaseMetrics["failureClass"] | undefined;
    let modalCount = 0;
    for (const [cls, count] of classCounts) {
      if (count > modalCount) {
        modalClass = cls;
        modalCount = count;
      }
    }
    if (modalClass) m.failureClass = modalClass;
  }

  return m;
}
