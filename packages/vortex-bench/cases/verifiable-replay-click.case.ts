// 可验证确定性重放——click 闭环端到端验证。
// 验证 vortex_act options.fingerprint = {mode:"record"} / {mode:"verify"} 的四个属性:
//   1. record: #eff 有副作用 → fingerprint.causedDomMutation = true
//   2. verify 同按钮复现 → drift null(matched)
//   3. verify #inert(target 不同 + 无 DOM 副作用)→ drift 含 "dom" 或 "target"
//   4. 零开销契约: 不传 fingerprint → 无 fingerprint / drift 字段
// 复用 click-effect-signal.html 的 #eff / #inert 按钮(与 click-effect-signal.case.ts 共享 playgroundPath)。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

interface ActWithFingerprint {
  success?: boolean;
  fingerprint?: {
    action: string;
    targetIdentity: string;
    causedDomMutation?: boolean;
    causedNetwork?: boolean;
    urlChanged?: boolean;
  };
  /** null = matched; Drift object = diverged */
  drift?: { classes: string[]; details: unknown[] } | null;
}

function parseActResult(res: unknown): ActWithFingerprint {
  return JSON.parse(extractText(res)) as ActWithFingerprint;
}

const def: CaseDefinition = {
  name: "verifiable-replay-click",
  playgroundPath: "/synth/click-effect-signal.html",
  tier: "medium",
  async run(ctx) {
    // ① record: 有效果按钮 #eff → fingerprint.causedDomMutation = true
    // server 在 fpActive 时自动补 observeEffect:true,所以 effect 字段有值。
    // observe 前置确保快照索引已建,targetIdentity lookupIdentity 能命中 ref。
    await ctx.call("vortex_observe", {});
    const rec = parseActResult(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#eff",
        options: { fingerprint: { mode: "record" } },
      }),
    );
    ctx.assert(
      rec.fingerprint != null,
      `record 应返回 fingerprint 字段: ${JSON.stringify(rec).slice(0, 300)}`,
    );
    ctx.assert(
      rec.fingerprint!.causedDomMutation === true,
      `#eff 有 DOM 副作用,record 应得 causedDomMutation=true: ${JSON.stringify(rec.fingerprint)}`,
    );

    const storedFp = rec.fingerprint!;

    // ② verify 同按钮(#eff)复现 → drift null(matched)
    await ctx.call("vortex_observe", {});
    const ok = parseActResult(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#eff",
        options: { fingerprint: { mode: "verify", expect: storedFp } },
      }),
    );
    ctx.assert(
      "drift" in ok,
      `verify 应返回 drift 字段(即便 matched 为 null): ${JSON.stringify(ok).slice(0, 300)}`,
    );
    ctx.assert(
      ok.drift === null,
      `效果复现应 matched(drift null), got ${JSON.stringify(ok.drift)}`,
    );

    // ③ verify #inert(target 不同 + 无 DOM 副作用)→ drift 含 "dom" 或 "target"
    await ctx.call("vortex_observe", {});
    const drifted = parseActResult(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#inert",
        options: { fingerprint: { mode: "verify", expect: storedFp } },
      }),
    );
    ctx.assert(
      drifted.drift != null,
      `惰性按钮副作用为 0 且 targetIdentity 不同,应有 drift: ${JSON.stringify(drifted).slice(0, 300)}`,
    );
    ctx.assert(
      drifted.drift!.classes.includes("dom") || drifted.drift!.classes.includes("target"),
      `drift 类别应含 "dom" 或 "target": ${JSON.stringify(drifted.drift!.classes)}`,
    );

    // ④ 零开销契约: 不传 fingerprint → 无 fingerprint / drift 字段
    await ctx.call("vortex_observe", {});
    const plain = parseActResult(
      await ctx.call("vortex_act", { action: "click", target: "#inert" }),
    );
    ctx.assert(
      plain.fingerprint == null,
      `零开销契约: 不传 fingerprint 时不应出现 fingerprint 字段, got ${JSON.stringify(plain.fingerprint)}`,
    );
    ctx.assert(
      !("drift" in plain),
      `零开销契约: 不传 fingerprint 时不应出现 drift 字段, got ${JSON.stringify((plain as Record<string, unknown>).drift)}`,
    );
  },
};
export default def;
