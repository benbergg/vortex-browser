// 缺口 E — OOPIF 基线(跨源/跨站 out-of-process iframe)。镜像 Stagehand oopif 任务。
// parent 在 localhost、child iframe src=127.0.0.1 → 跨源(Chrome site-isolation 出进程)。
// 实测确诊(2026-06-04):observe(all-permitted)经 getAllFrames 帧树枚举 surface 跨源帧内
// 按钮,act 经 per-frame 路径生效。验证法:点击改按钮自身文本(observe 跨帧可见),
// re-observe 看 marker(extract 不 surface 跨源子帧的非交互 <p>,故走 observe 验证)。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "oopif-plain-click",
  playgroundPath: "/synth/oopif-plain.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    const ref = findRef(snap, "跨源按钮");
    ctx.assert(ref !== null, `observe(all-permitted) 应穿跨源 OOPIF 暴露按钮。snapshot:\n${snap.slice(0, 500)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 500 });
    const after = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    ctx.assert(
      after.includes("OOPIF-CLICKED"),
      `act 应在跨源 OOPIF 内生效(按钮文本变 OOPIF-CLICKED)。after:\n${after.slice(0, 400)}`,
    );
  },
};
export default def;
