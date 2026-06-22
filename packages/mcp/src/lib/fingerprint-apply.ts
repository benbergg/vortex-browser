// 可验证确定性重放——record/verify 的纯逻辑(归一化 + 比对),与 MCP transport 解耦便于单测。
// server.ts act 路径在拿到带 effect 的 result 后调 applyFingerprint;autoRecover 决策走 shouldRecover。
import {
  normalizeClickFingerprint, compareFingerprint,
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

/**
 * Phase 1:仅 click 有 effect。其他 action 返回空(Task 9 扩展确定量指纹)。
 * - record:把本次 click effect 归一化成 fingerprint 回传。
 * - verify:同样归一化本次实测,再与 opt.expect 比对得 drift(null=matched)。
 * effect 缺失时返回空(观测信号未到位,绝不臆造)。
 * targetIdentity 为 null(CSS selector 无稳定身份 / 快照过期 / index 未命中)时诚实说明原因。
 */
export function applyFingerprint(
  opt: FingerprintOpt,
  action: string,
  targetIdentity: string | null,
  effect: ClickEffectLike | undefined,
): FingerprintOut {
  // Phase-1: 非 click 或无 effect 信号 → 真正的"无操作",静默返回空。
  if (action !== "click" || !effect) return {};
  // targetIdentity 缺失意味着调用方传入的是 CSS selector 而非 @ref,
  // 无稳定身份无法建立/验证指纹 → 诚实告知,不静默返回空。
  if (targetIdentity == null) {
    return {
      fingerprintSkipped:
        "fingerprint requires an @ref from vortex_observe; a CSS selector has no stable identity to record/verify",
    };
  }
  const fp = normalizeClickFingerprint(targetIdentity, effect);
  if (opt.mode === "record") return { fingerprint: fp };
  // verify:回传实测指纹 + drift(诚实表征,即便 matched 也让调用方看到实测值)。
  return { fingerprint: fp, drift: compareFingerprint(opt.expect, fp) };
}

/**
 * 是否应在 verify 检出 drift 后自动 re-observe。
 * 诚实优先:仅当显式 autoRecover:true 且确有 drift 时才 true;否则交回调用方(spec §5)。
 */
export function shouldRecover(opt: FingerprintOpt, drift: Drift | null): boolean {
  return opt.mode === "verify" && opt.autoRecover === true && drift != null;
}
