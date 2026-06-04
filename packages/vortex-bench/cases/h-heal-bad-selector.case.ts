// 缺口 H — 错 selector 的诚实契约(镜像 Stagehand heal_* 任务的反向语义)。
// Stagehand 给错 selector 期望系统"自愈"命中;vortex **无自愈语义**(确诊:全代码库无
// heal/fallbackSelector 逻辑)。vortex 的产品契约是相反方向——错/不存在的 target 应
// **优雅 ELEMENT_NOT_FOUND/TIMEOUT**,不静默假成功、不崩溃、不去猜别的元素。
// 本 case 锁这个"不静默自愈、干净失败"的契约。
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "h-heal-bad-selector",
  playgroundPath: "/synth/h-edge.html",
  tier: "medium",
  async run(ctx) {
    // 目标不存在:vortex 不应自愈到 #real,而应干净报错。
    const res = await ctx.call("vortex_act", {
      action: "click",
      target: "#ghost-does-not-exist",
      options: { timeout: 1500 },
    });
    const detail = extractText(res);
    const errored = Boolean((res as { isError?: boolean }).isError) || /Error \[[A-Z_]+\]/.test(detail);
    ctx.assert(
      errored,
      `错 selector 应优雅报错(ELEMENT_NOT_FOUND/TIMEOUT),不得静默假成功。detail=${detail.slice(0, 150)}`,
    );
    // 反向证明:没有"自愈"去点到真实按钮(result 仍 idle)。
    const result = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", {
        code: "return document.querySelector('[data-testid=\"result\"]').textContent.trim();",
      }),
    );
    ctx.assert(
      result === "idle",
      `不应自愈误点其他元素,result 应保持 idle,实际 "${result}"`,
    );
  },
};
export default def;
