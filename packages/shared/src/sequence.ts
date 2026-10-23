// 序列执行的纯逻辑：步骤三态判定与轨迹汇总。
//
// **为什么在 shared**：MCP 的 vortex_sequence 与 CLI 的 vortex sequence 是同一个能力
// （「多步序列，每步自证」），两边的判定口径必须逐字一致，否则同一个序列在两条路上
// 会给出不同的 verified/unverified 结论。原实现只在 packages/mcp/src/lib/sequence-run.ts，
// CLI 直连扩展没有 MCP 层、拿不到它 —— 于是各写一份必然漂移。
// 现在这份逻辑住在 shared，MCP 侧 sequence-run.ts 转出同一份，CLI 直接 import。
//
// 三态而非 ok/error：非幂等动作在「已执行但未验证」下重试会造成重复副作用，
// 调用方必须能把它与「根本没执行」分开。
import type { ClickEffectLike } from "./effect-fingerprint.js";

export type StepState = "not_executed" | "executed_unverified" | "executed_verified" | "failed";
export type OnFailure = "stop" | "continue";

export interface StepTrace {
  index: number;
  action: string;
  target: string;
  state: StepState;
  error?: string;
  drift?: { classes: string[] } | null;
  effect?: StepEffect;
  /** 该步工具的降级/空结果自陈。单调 vortex_act 时经渲染层单独成块,序列里只能挂在步上 */
  diagnosis?: string;
}

/** confirmed=有证据生效;unconfirmed=有证据未生效;unknown=无可用信号。三值不可合成布尔。 */
export type StepEffect = "confirmed" | "unconfirmed" | "unknown";

/**
 * 指纹漂移的最小结构（MCP 侧 FingerprintOut 的结构子集）。
 * 只取 drift，别的字段对三态判定没用 —— CLI 没有 expect 指纹，只有 MCP 侧会填。
 */
export interface StepFingerprintLike {
  drift?: { classes: string[] } | null;
}

const READBACK_CAP = 500;

/** 回读值在扩展侧封顶 500 加省略号,入参不施加同样截断则长文本必然误判。 */
function capped(v: string): string {
  return v.length > READBACK_CAP ? v.slice(0, READBACK_CAP) + "…" : v;
}

export function verifyStepEffect(
  action: string,
  requested: unknown,
  result: Record<string, unknown>,
): StepEffect {
  if (action === "fill" || action === "type" || action === "select") {
    const back = result.value;
    if (typeof back !== "string") return "unknown";
    const want = typeof requested === "string" ? requested : JSON.stringify(requested);
    if (typeof want !== "string") return "unknown";
    if (capped(want) === back) return "confirmed";
    // select 回读的是 option value,与传入的可见文本本就可能不同,分不清选错还是标签≠值
    return action === "select" ? "unknown" : "unconfirmed";
  }
  if (action === "scroll") {
    if (typeof result.moved !== "boolean") return "unknown";
    return result.moved ? "confirmed" : "unconfirmed";
  }
  if (action === "click" || action === "hover") {
    const e = result.effect as ClickEffectLike | undefined;
    if (!e) return "unknown";
    const any =
      e.domMutations > 0 || e.networkRequests > 0 || e.urlChanged ||
      e.focusChanged || e.ariaChanged || e.userFeedback !== "none";
    return any ? "confirmed" : "unconfirmed";
  }
  return "unknown";
}

export function classifyStep(outcome: {
  ok: boolean; error?: string; fp: StepFingerprintLike; effect?: StepEffect;
}): { state: StepState; drift?: { classes: string[] } | null; effect?: StepEffect } {
  if (!outcome.ok) return { state: "failed" };
  const drift = outcome.fp.drift;
  // 重放路径:有 expect 指纹时以 drift 为准
  if (drift === null) return { state: "executed_verified", drift: null, effect: outcome.effect };
  if (drift) return { state: "executed_unverified", drift, effect: outcome.effect };
  // 新建序列没有 expect,只能靠单步自证
  if (outcome.effect === "confirmed") return { state: "executed_verified", effect: "confirmed" };
  return { state: "executed_unverified", effect: outcome.effect ?? "unknown" };
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

export interface SequenceStepInput { action: string; target: string; value?: unknown }

export interface SequenceOutcome {
  ok: boolean;
  error?: string;
  diagnosis?: string;
  result?: Record<string, unknown>;
  fp?: StepFingerprintLike;
}

export interface SequenceReport {
  summary: ReturnType<typeof summarizeTrace>;
  steps: StepTrace[];
}

/** 循环本身不做 I/O,由 send 注入,这样测试驱动的是真代码而非复刻的骨架。 */
export async function runSequence(
  steps: SequenceStepInput[],
  onFailure: OnFailure,
  send: (step: SequenceStepInput, index: number) => Promise<SequenceOutcome>,
): Promise<SequenceReport> {
  const traces: StepTrace[] = steps.map((s, i) => ({
    index: i, action: s.action, target: s.target, state: "not_executed" as const,
  }));
  for (let i = 0; i < steps.length; i++) {
    let out: SequenceOutcome;
    try {
      out = await send(steps[i], i);
    } catch (err) {
      // send 抛错等同该步未执行,可安全重试;不能让一步的异常掀掉整次调用
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const effect = out.ok && out.result
      ? verifyStepEffect(steps[i].action, steps[i].value, out.result)
      : undefined;
    const c = classifyStep({ ok: out.ok, error: out.error, fp: out.fp ?? {}, effect });
    traces[i] = {
      ...traces[i], state: c.state, drift: c.drift, effect: c.effect, error: out.error,
      // 条件展开:JSON 之外的 in-memory 消费者靠键存在性判断有没有自陈
      ...(out.diagnosis ? { diagnosis: out.diagnosis } : {}),
    };
    if (!shouldContinue(c.state, onFailure)) break;
  }
  return { summary: summarizeTrace(traces), steps: traces };
}
