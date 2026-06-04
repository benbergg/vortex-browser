// 缺口 E2 — 同源 iframe(SPIF)点击。镜像 Stagehand iframe act 变体:
// observe(all)穿同源子帧 → act-via-ref → extract 标记。grounding 已确证 act 触发真 handler。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, assertExtractEquals } from "./_helpers.js";

const def: CaseDefinition = {
  name: "iframe-spif-click",
  playgroundPath: "/synth/iframe-spif-click.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all" }));
    const ref = findRef(snap, "iframe 同源按钮");
    ctx.assert(ref !== null, `observe(all) 应暴露 SPIF 内按钮。snapshot:\n${snap.slice(0, 400)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await assertExtractEquals(ctx, '[data-testid="result"]', "spif-clicked");
  },
};
export default def;
