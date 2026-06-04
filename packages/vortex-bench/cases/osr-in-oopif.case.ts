// 缺口 E — open shadow ⊂ 跨源 OOPIF。镜像 Stagehand osr_in_oopif:
// 跨"跨源 iframe 边界 + open shadow 边界"双层定位。实测确诊(2026-06-04):可达——
// per-frame 注入后 querySelectorAllDeep 穿该帧的 open shadow。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "osr-in-oopif",
  playgroundPath: "/synth/osr-in-oopif.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    const ref = findRef(snap, "shadow按钮");
    ctx.assert(ref !== null, `observe 应穿跨源 OOPIF + open shadow 暴露按钮。snapshot:\n${snap.slice(0, 500)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 500 });
    const after = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    ctx.assert(
      after.includes("OSR-OOPIF-CLICKED"),
      `act 应在 OOPIF 内 open shadow 生效。after:\n${after.slice(0, 400)}`,
    );
  },
};
export default def;
