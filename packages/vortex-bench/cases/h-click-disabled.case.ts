// 缺口 H — disabled 元素优雅失败。act 点 disabled 按钮应明确报错(DISABLED),
// 非 success:true 却把 result 改成 disabled-clicked(锁"不假成功"契约)。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "h-click-disabled",
  playgroundPath: "/synth/h-click-disabled.html",
  tier: "hard",
  async run(ctx) {
    let errored = false;
    let detail = "";
    try {
      const res = await ctx.call("vortex_act", {
        action: "click",
        target: "#b",
        options: { timeout: 1500 },
      });
      detail = extractText(res);
      errored = Boolean((res as { isError?: boolean }).isError) || /Error \[[A-Z_]+\]/.test(detail);
    } catch (e) {
      errored = true;
      detail = e instanceof Error ? e.message : String(e);
    }
    ctx.assert(errored, `disabled 元素 act 应明确报错,实际无错误: ${detail.slice(0, 200)}`);
    const result = extractText(
      await ctx.call("vortex_extract", { target: '[data-testid="result"]', include: ["text"] }),
    );
    ctx.assert(
      !result.includes("disabled-clicked"),
      `disabled 不应被点中(假成功),result=${result}`,
    );
  },
};
export default def;
