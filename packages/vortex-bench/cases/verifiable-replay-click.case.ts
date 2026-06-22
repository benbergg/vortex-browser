// 可验证确定性重放——click 闭环端到端验证。
// 验证 vortex_act options.fingerprint = {mode:"record"} / {mode:"verify"} 的四个属性:
//   1. record: 有效果按钮 → fingerprint.causedDomMutation = true
//   2. verify 同按钮复现 → drift null(matched)
//   3. verify 惰性按钮(target 不同 + 无 DOM 副作用)→ drift 含 "dom" 或 "target"
//   4. 零开销契约: 不传 fingerprint → 无 fingerprint / drift 字段
// 复用 click-effect-signal.html 的"有效果按钮"/"惰性按钮"(与 click-effect-signal.case.ts 共享 playgroundPath)。
//
// 重要:target 必须用 vortex_observe 返回的 @ref(如 @3f5f:e1),而非原始 CSS selector(#eff / #inert)。
// ref-parser.ts:108 只在 @eN 形式下设 params.index;selector 形式的 params.index 始终为 undefined,
// 导致 lookupIdentity 返回 null → applyFingerprint 无法建立 targetIdentity → fingerprint 字段缺失。
// 使用 @ref 可保证 lookupIdentity 正确查到 role::name::frameId 身份串,是 record/verify 的真实路径。
import type { CaseDefinition } from "../src/types.js";
import { extractText, findRef } from "./_helpers.js";

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
    // 前置 observe:建立快照索引,提取两个按钮的 @ref。
    // click-effect-signal.html 中按钮文本:
    //   #eff   → accessible name "有效果按钮"
    //   #inert → accessible name "惰性按钮"
    const snap1 = extractText(await ctx.call("vortex_observe", {}));
    const effRef = findRef(snap1, "有效果按钮");
    ctx.assert(
      effRef !== null,
      `observe 应能看到"有效果按钮",snapshot head:\n${snap1.slice(0, 600)}`,
    );
    const inertRef = findRef(snap1, "惰性按钮");
    ctx.assert(
      inertRef !== null,
      `observe 应能看到"惰性按钮",snapshot head:\n${snap1.slice(0, 600)}`,
    );

    // warmup: 先点一次"有效果按钮"使其获得焦点,让后续 record/verify 的 focusChanged 稳定为 false。
    // 否则 record 捕捉首次点击的 focusChanged:true,而 verify 时按钮已聚焦(focusChanged:false)→ 假 focus drift。
    // focusChanged 是"首次 vs 后续点击同元素"的不稳定信号,只有 e2e 才暴露(单测 / 静态 review 看不到运行时焦点行为)。
    await ctx.call("vortex_act", { action: "click", target: effRef! });
    const snapW = extractText(await ctx.call("vortex_observe", {}));
    const effRefW = findRef(snapW, "有效果按钮");
    ctx.assert(effRefW !== null, `warmup 后 observe 应能看到"有效果按钮"`);

    // ① record: 有效果按钮 → fingerprint.causedDomMutation = true
    // server 在 fpActive 时自动补 observeEffect:true,所以 effect 字段有值。
    // 使用 @ref(effRefW)确保 lookupIdentity 能命中快照并返回 role::name::frameId 身份串。
    const rec = parseActResult(
      await ctx.call("vortex_act", {
        action: "click",
        target: effRefW!,
        options: { fingerprint: { mode: "record" } },
      }),
    );
    ctx.assert(
      rec.fingerprint != null,
      `record 应返回 fingerprint 字段: ${JSON.stringify(rec).slice(0, 300)}`,
    );
    ctx.assert(
      rec.fingerprint!.causedDomMutation === true,
      `有效果按钮有 DOM 副作用,record 应得 causedDomMutation=true: ${JSON.stringify(rec.fingerprint)}`,
    );

    const storedFp = rec.fingerprint!;

    // ② verify 同按钮(有效果按钮)复现 → drift null(matched)
    const snap2 = extractText(await ctx.call("vortex_observe", {}));
    const effRef2 = findRef(snap2, "有效果按钮");
    ctx.assert(effRef2 !== null, `第二次 observe 应能看到"有效果按钮"`);
    const ok = parseActResult(
      await ctx.call("vortex_act", {
        action: "click",
        target: effRef2!,
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

    // ③ verify 惰性按钮(target 不同 + 无 DOM 副作用)→ drift 含 "dom" 或 "target"
    const snap3 = extractText(await ctx.call("vortex_observe", {}));
    const inertRef3 = findRef(snap3, "惰性按钮");
    ctx.assert(inertRef3 !== null, `第三次 observe 应能看到"惰性按钮"`);
    const drifted = parseActResult(
      await ctx.call("vortex_act", {
        action: "click",
        target: inertRef3!,
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
    // CSS selector 可用于零开销路径,因为 fpActive=false 时整个指纹块被跳过。
    const snap4 = extractText(await ctx.call("vortex_observe", {}));
    const inertRef4 = findRef(snap4, "惰性按钮");
    ctx.assert(inertRef4 !== null, `第四次 observe 应能看到"惰性按钮"`);
    const plain = parseActResult(
      await ctx.call("vortex_act", { action: "click", target: inertRef4! }),
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
