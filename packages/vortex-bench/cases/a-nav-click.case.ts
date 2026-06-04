// 缺口 A — 导航点击 + URL 验证。镜像 Stagehand amazon/wikipedia/ionwave:
// 点链接触发导航,验 location 变化。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "a-nav-click",
  playgroundPath: "/synth/a-nav-click.html",
  tier: "easy",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const ref = findRef(snap, "去目标页");
    ctx.assert(ref !== null, `observe 应暴露链接。snapshot:\n${snap.slice(0, 300)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 2000 });
    const loc = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", { code: "return location.pathname;" }),
    );
    ctx.assert(loc.includes("a-nav-target"), `点击应跳转到 a-nav-target,实际 ${loc}`);
  },
};
export default def;
