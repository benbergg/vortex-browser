// 缺口 C — 原生表单控件(checkbox/radio,区别于 Element Plus el-*)。
// 镜像 Stagehand checkboxes/radio_btn:勾选后读 checked 验证。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "c-native-controls",
  playgroundPath: "/synth/c-native-controls.html",
  tier: "easy",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const cb = findRef(snap, "勾选项");
    const rb = findRef(snap, "选项B");
    ctx.assert(
      cb !== null && rb !== null,
      `observe 应暴露原生 checkbox+radio。snapshot:\n${snap.slice(0, 400)}`,
    );
    await ctx.call("vortex_act", { action: "click", target: cb as string });
    await ctx.call("vortex_act", { action: "click", target: rb as string });
    const s = extractEvalJson<{ cb: boolean; rb: boolean }>(
      await ctx.call("vortex_evaluate", {
        code: "return {cb:document.getElementById('cb').checked, rb:document.getElementById('rB').checked};",
      }),
    );
    ctx.assert(s.cb === true, `checkbox 应勾选,实际 ${s.cb}`);
    ctx.assert(s.rb === true, `radio B 应选中,实际 ${s.rb}`);
  },
};
export default def;
