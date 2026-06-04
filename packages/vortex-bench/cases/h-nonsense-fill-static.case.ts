// 缺口 H — nonsense 指令优雅拒绝(镜像 Stagehand nonsense_action 期望 success:false)。
// 对纯文本 <p>(不可编辑)发 fill 是语义无效指令:vortex 应优雅 NOT_EDITABLE 报错,
// **不静默假成功**、不把值硬塞进 textContent。锁"语义无效操作干净拒绝"契约。
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "h-nonsense-fill-static",
  playgroundPath: "/synth/h-edge.html",
  tier: "medium",
  async run(ctx) {
    const before = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", {
        code: "return document.getElementById('static').textContent.trim();",
      }),
    );
    // 对不可编辑 <p> 发 fill:nonsense 指令,应优雅 NOT_EDITABLE。
    const res = await ctx.call("vortex_act", {
      action: "fill",
      target: "#static",
      value: "should-not-apply",
      options: { timeout: 1500 },
    });
    const detail = extractText(res);
    const errored = Boolean((res as { isError?: boolean }).isError) || /Error \[[A-Z_]+\]/.test(detail);
    ctx.assert(
      errored,
      `对不可编辑元素 fill 应优雅报错(NOT_EDITABLE),不得静默假成功。detail=${detail.slice(0, 150)}`,
    );
    // 没有把值硬塞进 textContent。
    const after = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", {
        code: "return document.getElementById('static').textContent.trim();",
      }),
    );
    ctx.assert(
      after === before && !after.includes("should-not-apply"),
      `不应改动不可编辑元素文本,before="${before}" after="${after}"`,
    );
  },
};
export default def;
