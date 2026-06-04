// 缺口 E — 跨源 OOPIF ⊂ open shadow。镜像 Stagehand oopif_in_osr:
// 跨源 iframe 宿主元素在 parent 的 open shadow 内。实测确诊(2026-06-04):可达——
// getAllFrames 枚举到该帧 + 帧内 per-frame 注入,open shadow 不阻断帧发现。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "oopif-in-osr",
  playgroundPath: "/synth/oopif-in-osr.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    const ref = findRef(snap, "跨源按钮");
    ctx.assert(ref !== null, `observe 应穿 open shadow 内的跨源 OOPIF 暴露按钮。snapshot:\n${snap.slice(0, 500)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 500 });
    const after = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    ctx.assert(
      after.includes("OOPIF-CLICKED"),
      `act 应在 open shadow 内的 OOPIF 生效。after:\n${after.slice(0, 400)}`,
    );
  },
};
export default def;
