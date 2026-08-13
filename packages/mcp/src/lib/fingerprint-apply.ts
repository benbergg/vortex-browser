// 可验证确定性重放——record/verify 的纯逻辑(归一化 + 比对),与 MCP transport 解耦便于单测。
// server.ts act 路径在拿到带 effect 的 result 后调 applyFingerprint;autoRecover 决策走 shouldRecover。
import {
  normalizeClickFingerprint, normalizeValueFingerprint, normalizeScrollFingerprint,
  compareFingerprint,
  type EffectFingerprint, type ClickEffectLike, type Drift,
} from "@vortex-browser/shared";

export type FingerprintOpt =
  | { mode: "record" }
  | { mode: "verify"; expect: EffectFingerprint; autoRecover?: boolean };

export interface FingerprintOut {
  fingerprint?: EffectFingerprint;
  drift?: Drift | null;
  /** CSS selector 路径无法建立稳定 targetIdentity,诚实说明原因而非静默返回空。 */
  fingerprintSkipped?: string;
}

export type ActionSignals =
  | { kind: "click"; effect: ClickEffectLike }
  | { kind: "value"; value: string }
  | { kind: "scroll"; scrollAfter: { top: number; left: number } };

/** 按 action 取对应确定量归一化。信号缺失=观测未到位,返回空绝不臆造。 */
export function applyFingerprint(
  opt: FingerprintOpt,
  action: string,
  targetIdentity: string | null,
  signals: ActionSignals | undefined,
): FingerprintOut {
  if (!signals) return {};
  if (targetIdentity == null) {
    return {
      fingerprintSkipped:
        "fingerprint requires an @ref from vortex_observe; a CSS selector has no stable identity to record/verify",
    };
  }
  let fp: EffectFingerprint;
  if (signals.kind === "click") {
    fp = normalizeClickFingerprint(targetIdentity, signals.effect);
  } else if (signals.kind === "value") {
    fp = normalizeValueFingerprint(action as "fill" | "type" | "select", targetIdentity, signals.value);
  } else {
    fp = normalizeScrollFingerprint(targetIdentity, signals.scrollAfter);
  }
  if (opt.mode === "record") return { fingerprint: fp };
  return { fingerprint: fp, drift: compareFingerprint(opt.expect, fp) };
}

/**
 * 是否应在 verify 检出 drift 后自动 re-observe。
 * 诚实优先:仅当显式 autoRecover:true 且确有 drift 时才 true;否则交回调用方(spec §5)。
 */
export function shouldRecover(opt: FingerprintOpt, drift: Drift | null): boolean {
  return opt.mode === "verify" && opt.autoRecover === true && drift != null;
}

/** 从 act 结果取确定量。字段形状对齐 extension/src/handlers/dom.ts 各动作返回。 */
export function extractSignals(
  action: string,
  result: Record<string, unknown>,
): ActionSignals | undefined {
  if (action === "click") {
    const effect = result.effect as ClickEffectLike | undefined;
    return effect ? { kind: "click", effect } : undefined;
  }
  if (action === "fill" || action === "type" || action === "select") {
    const v = result.value;
    if (v === undefined) return undefined;
    // 多选 select 回读是数组,序列化后才能进 valueAfter 的字符串比对
    return { kind: "value", value: typeof v === "string" ? v : JSON.stringify(v) };
  }
  if (action === "scroll") {
    const top = result.scrollTop, left = result.scrollLeft;
    if (typeof top !== "number" || typeof left !== "number") return undefined;
    if (result.scrolledSelf !== true) return undefined;
    return { kind: "scroll", scrollAfter: { top, left } };
  }
  return undefined;
}
