// 失败路径 · actionability（suite B 3/7）：被遮挡的目标必须给出**可判读**的失败。
//
// 契约：目标被别的元素盖住时，act 必须报一个明确的错误码（OBSCURED），
// 让人/agent 知道"被谁挡住了"；不能只丢一个 TIMEOUT（那是"等超时了"，
// 不是"这个目标打不到"），更不能静默假成功（success:true 但什么都没发生）。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, assertExtractEquals } from "../_helpers.js";

const def: CaseDefinition = {
  name: "contract/occluded-target",
  suite: "b",
  async run(ctx) {
    await ctx.call("vortex_navigate", { url: `${ctx.baseUrl}/occluded` });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });

    const res = await ctx.call("vortex_act", {
      action: "click",
      target: "#covered",
      options: { timeout: 1200 },
    });
    const text = extractText(res);
    ctx.assert(
      /Error \[OBSCURED\]/.test(text),
      `被遮挡目标应报 OBSCURED，实际: ${text.slice(0, 300)}`,
    );
    ctx.assert(
      !/Error \[TIMEOUT\]/.test(text),
      `遮挡不应被压成 TIMEOUT（那是"等超时"不是"打不到"），实际: ${text.slice(0, 300)}`,
    );
    // 可判读：错误文本要指出"被什么挡住了"
    ctx.assert(
      /#cover/.test(text),
      `OBSCURED 文本应指出遮挡元素（#cover），实际: ${text.slice(0, 300)}`,
    );
    // 不得静默假成功：按钮没被点到（文本仍是原文）
    await assertExtractEquals(ctx, "#covered", "Covered");
  },
};
export default def;
