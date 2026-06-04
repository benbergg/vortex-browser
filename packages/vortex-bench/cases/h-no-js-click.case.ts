// 缺口 H — 真实点击(no-js-click)。镜像 Stagehand no_js_click:
// 仅 isTrusted 点击置 "trusted-clicked",合成点击得 "synthetic-blocked"。
// 产品级标准 = 真实点击生效(检验 vortex click 是否产生 isTrusted 事件)。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, assertExtractEquals } from "./_helpers.js";

const def: CaseDefinition = {
  name: "h-no-js-click",
  playgroundPath: "/synth/h-no-js-click.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const ref = findRef(snap, "真实点击按钮");
    ctx.assert(ref !== null, `observe 应暴露按钮。snapshot:\n${snap.slice(0, 300)}`);
    // isTrusted 检查站点:用 useRealMouse 走 CDP 真实点击(实测确诊 → "trusted-clicked")。
    await ctx.call("vortex_act", { action: "click", target: ref as string, useRealMouse: true });
    await assertExtractEquals(ctx, '[data-testid="result"]', "trusted-clicked");
  },
};
export default def;
