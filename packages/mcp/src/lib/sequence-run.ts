// 序列执行的纯逻辑:步骤三态判定与轨迹汇总,与 MCP transport 解耦便于单测。
// 三态而非 ok/error:非幂等动作在「已执行但未验证」下重试会造成重复副作用,
// 调用方必须能把它与「根本没执行」分开。
import type { FingerprintOut } from "./fingerprint-apply.js";

export type StepState = "not_executed" | "executed_unverified" | "executed_verified" | "failed";
export type OnFailure = "stop" | "continue";

export interface StepTrace {
  index: number;
  action: string;
  target: string;
  state: StepState;
  error?: string;
  drift?: { classes: string[] } | null;
}

export function classifyStep(outcome: { ok: boolean; error?: string; fp: FingerprintOut }): {
  state: StepState;
  drift?: { classes: string[] } | null;
} {
  if (!outcome.ok) return { state: "failed" };
  const drift = outcome.fp.drift;
  if (drift === null) return { state: "executed_verified", drift: null };
  if (drift) return { state: "executed_unverified", drift };
  // 无指纹:record 模式或信号未到位,已执行但无从验证,不谎称已验证
  return { state: "executed_unverified" };
}

export function shouldContinue(state: StepState, onFailure: OnFailure): boolean {
  if (onFailure === "continue") return true;
  return state === "executed_verified";
}

export function summarizeTrace(traces: StepTrace[]): {
  total: number; verified: number; unverified: number; failed: number; notExecuted: number;
} {
  const count = (s: StepState): number => traces.filter((t) => t.state === s).length;
  return {
    total: traces.length,
    verified: count("executed_verified"),
    unverified: count("executed_unverified"),
    failed: count("failed"),
    notExecuted: count("not_executed"),
  };
}
