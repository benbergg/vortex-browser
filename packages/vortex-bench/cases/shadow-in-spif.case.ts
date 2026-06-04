// 缺口 E2 — open shadow ⊂ 同源 iframe。镜像 Stagehand osr_in_spif:
// 跨"iframe 边界 + shadow 边界"双层定位元素。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, assertExtractEquals } from "./_helpers.js";

const def: CaseDefinition = {
  name: "shadow-in-spif",
  playgroundPath: "/synth/shadow-in-spif.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all" }));
    const ref = findRef(snap, "shadow-in-spif 按钮");
    ctx.assert(ref !== null, `observe(all) 应穿 iframe+open shadow 暴露按钮。snapshot:\n${snap.slice(0, 500)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await assertExtractEquals(ctx, '[data-testid="result"]', "shadow-in-spif-clicked");
  },
};
export default def;
