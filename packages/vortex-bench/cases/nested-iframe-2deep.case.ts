// 缺口 E2 — 2 层嵌套同源 iframe。镜像 Stagehand nested_iframes:
// main → iframe → iframe → button,跨 3 层 frame 定位并操作。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, assertExtractEquals } from "./_helpers.js";

const def: CaseDefinition = {
  name: "nested-iframe-2deep",
  playgroundPath: "/synth/nested-iframe-2deep.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all" }));
    const ref = findRef(snap, "nested 2deep 按钮");
    ctx.assert(ref !== null, `observe(all) 应穿 2 层嵌套 iframe 暴露按钮。snapshot:\n${snap.slice(0, 500)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await assertExtractEquals(ctx, '[data-testid="result"]', "nested-2deep-clicked");
  },
};
export default def;
