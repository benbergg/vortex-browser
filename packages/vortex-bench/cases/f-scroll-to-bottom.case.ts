// 缺口 F — 滚动到底部 + scrollY 精度。镜像 Stagehand scroll_*:滚动后验落点。
// vortex position 支持 top/bottom/坐标(不支持 %,见设计 backlog)。scroll 调用形态
// 来自 jd-review-rm-03(value={container?,position})。
import type { CaseDefinition } from "../src/types.js";
import { extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "f-scroll-to-bottom",
  playgroundPath: "/synth/f-scroll-page.html",
  tier: "medium",
  async run(ctx) {
    await ctx.call("vortex_act", { action: "scroll", value: { position: "bottom" } });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 500 });
    const s = extractEvalJson<{ y: number; max: number }>(
      await ctx.call("vortex_evaluate", {
        code: "return {y: Math.round(window.scrollY), max: Math.round(document.documentElement.scrollHeight - window.innerHeight)};",
      }),
    );
    ctx.assert(
      Math.abs(s.y - s.max) <= 50,
      `应滚到底部(scrollY≈${s.max}),实际 scrollY=${s.y}`,
    );
  },
};
export default def;
