// packages/vortex-bench/src/runner/robustness-aggregate.ts
// 纯逻辑:一页所有 RefOutcome → 直方图 + okRate + R0/R1 finding。
// 含契约违反检测:observe 刚发的 ref,act 回这些 code = observe→act 握手断了。

import type { RefOutcome, FixtureRobustness, RobustnessFinding } from "../robustness-types.js";

/**
 * 契约违反码:出现在"observe 刚发的 ref"上意味着 observe 发了个 act 用不了的废 ref
 * (如 shadow-internal ref → ELEMENT_NOT_FOUND,见记忆 vortex_observe_codepath_gotcha)。
 * 其余 typed-error(OBSCURED 等)是 actionability 降级,归 R1。
 */
export const CONTRACT_VIOLATION_CODES = new Set<string>([
  "NOT_ATTACHED",
  "ELEMENT_NOT_FOUND",
  "STALE_SNAPSHOT",
]);

export function aggregateFixture(
  fixture: string,
  path: string,
  outcomes: RefOutcome[],
): FixtureRobustness {
  const histogram: Record<string, number> = {};
  const findings: RobustnessFinding[] = [];
  let okCount = 0;

  for (const out of outcomes) {
    const key = out.kind === "typed-error" ? `typed-error:${out.code}` : out.kind;
    histogram[key] = (histogram[key] ?? 0) + 1;

    if (out.kind === "ok") {
      okCount++;
      continue;
    }

    let severity: "R0" | "R1";
    let code: string;
    if (out.kind === "crash") {
      severity = "R0";
      code = "crash";
    } else if (out.kind === "timeout") {
      severity = "R0";
      code = "timeout";
    } else {
      // typed-error
      code = out.code ?? "UNKNOWN";
      severity = CONTRACT_VIOLATION_CODES.has(code) ? "R0" : "R1";
    }

    findings.push({
      severity,
      fixture,
      ref: out.ref,
      code,
      detail: `[${out.role}] "${out.name ?? ""}" — ${out.detail}`,
    });
  }

  const totalRefs = outcomes.length;
  return {
    fixture,
    path,
    totalRefs,
    okCount,
    okRate: totalRefs === 0 ? 1 : okCount / totalRefs,
    histogram,
    findings,
  };
}
