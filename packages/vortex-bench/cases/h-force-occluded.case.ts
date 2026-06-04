// 缺口 H — force 绕过 actionability。镜像 Stagehand google_flights force 任务。
// 对比 b-occluded-input(非 force → OBSCURED 拒填):本 case 用 options.force:true
// 应**绕过 OBSCURED 门真把值填进去**。这是 force 已实现(非 no-op)的页面锚定证明。
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "h-force-occluded",
  playgroundPath: "/synth/b-occluded-input.html",
  tier: "hard",
  async run(ctx) {
    // force:true 应绕过半透明层的 OBSCURED 门,直接把值写入被遮挡的 input。
    const res = await ctx.call("vortex_act", {
      action: "fill",
      target: "#inp",
      value: "forced-ok",
      options: { force: true, timeout: 2000 },
    });
    const detail = extractText(res);
    const errored = Boolean((res as { isError?: boolean }).isError) || /Error \[[A-Z_]+\]/.test(detail);
    ctx.assert(!errored, `force fill 不应报错(应绕过 OBSCURED)。detail=${detail.slice(0, 150)}`);

    const v = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", { code: "return document.getElementById('inp').value;" }),
    );
    ctx.assert(
      v === "forced-ok",
      `force:true 应绕过 actionability 把值填入全覆盖 input,实际 value="${v}"`,
    );
  },
};
export default def;
