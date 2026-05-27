// packages/vortex-bench/src/runner/robustness-confirm.ts
// #3.x live 二次确认(纯逻辑):过滤 live 页面 mutation 抖动。
// pass1 中契约违反的 outcome,只有在 settle+重 observe 后同身份(role+name)元素仍存在
// 且重 extract 仍违反契约时才"确认"(真 bug);恢复(ok)/消失(S2 无同身份)判抖动丢弃。

import type { RefOutcome } from "../robustness-types.js";
import { CONTRACT_VIOLATION_CODES } from "./robustness-aggregate.js";

/** 稳定身份 = role + " " + name(复用 #1 invariants 的 identity 概念) */
export function refIdentity(role: string, name: string | null): string {
  return `${role} ${name ?? ""}`;
}

/**
 * @param pass1Failures pass1 中 code ∈ CONTRACT_VIOLATION_CODES 的 outcome
 * @param pass2ByIdentity identity → 该身份在 S2 重 extract 的 outcomes(可能多个同名行)
 * @returns 被确认的 R0 outcome 子集(其余为抖动,不返回)
 */
export function confirmContractViolations(
  pass1Failures: RefOutcome[],
  pass2ByIdentity: Map<string, RefOutcome[]>,
): RefOutcome[] {
  const confirmed: RefOutcome[] = [];
  for (const f of pass1Failures) {
    const s2 = pass2ByIdentity.get(refIdentity(f.role, f.name));
    if (!s2 || s2.length === 0) continue; // 元素消失 → 抖动
    const stillViolating = s2.some(
      (out) => out.kind === "typed-error" && out.code !== null && CONTRACT_VIOLATION_CODES.has(out.code),
    );
    if (stillViolating) confirmed.push(f); // 持续违反 → 确认;全恢复 → 抖动丢弃
  }
  return confirmed;
}
