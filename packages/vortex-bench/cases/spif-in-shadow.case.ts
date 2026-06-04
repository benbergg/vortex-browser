// 缺口 E2 — 同源 iframe ⊂ open shadow。镜像 Stagehand spif_in_osr:
// shadow 边界里再嵌 iframe,跨"shadow + iframe"双层定位元素。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, assertExtractEquals } from "./_helpers.js";

const def: CaseDefinition = {
  name: "spif-in-shadow",
  playgroundPath: "/synth/spif-in-shadow.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all" }));
    const ref = findRef(snap, "spif-in-shadow 按钮");
    ctx.assert(ref !== null, `observe(all) 应穿 open shadow+iframe 暴露按钮。snapshot:\n${snap.slice(0, 500)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await assertExtractEquals(ctx, '[data-testid="result"]', "spif-in-shadow-clicked");
  },
};
export default def;
