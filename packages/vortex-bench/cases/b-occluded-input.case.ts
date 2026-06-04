// 缺口 B — 全覆盖 input 的诚实契约。fixture 半透明层完全盖住 input。
// 产品决策(2026-06-04):vortex 取保守——对全覆盖元素报 OBSCURED 拒填(用户也点不到),
// 不向 Stagehand"强行填穿"看齐。本 case 锁的是**不静默假成功**:
//   要么明确报错(OBSCURED/TIMEOUT),要么真把值填进去;不得 success:true 却 value 空。
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "b-occluded-input",
  playgroundPath: "/synth/b-occluded-input.html",
  tier: "hard",
  async run(ctx) {
    let errored = false;
    let detail = "";
    try {
      const res = await ctx.call("vortex_act", {
        action: "fill",
        target: "#inp",
        value: "occluded-OK",
        options: { timeout: 1500 },
      });
      detail = extractText(res);
      errored = Boolean((res as { isError?: boolean }).isError) || /Error \[[A-Z_]+\]/.test(detail);
    } catch (e) {
      errored = true;
      detail = e instanceof Error ? e.message : String(e);
    }
    const v = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", { code: "return document.getElementById('inp').value;" }),
    );
    const filled = v === "occluded-OK";
    ctx.assert(
      errored || filled,
      `全覆盖 input:应明确报错(OBSCURED)或真填入,不得静默假成功。errored=${errored} value="${v}" detail=${detail.slice(0, 150)}`,
    );
  },
};
export default def;
