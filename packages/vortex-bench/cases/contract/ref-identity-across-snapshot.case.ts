// 失败路径 · ref 身份（suite B 2/7）：跨快照的 ref 身份安全。
//
// 契约：observe 发布的 hashed ref（@<hash>:eN）带**快照身份**。跨快照再用它时，
// 运行时要么仍命中同一元素，要么**响亮地**报 STALE_SNAPSHOT（hint 指引重新 observe）；
// 绝不允许"静默改指别的元素"——把按钮点击打到输入框上是最难查的一类事故。
// 裸 ref（@eN）没有身份锚（observe 会重排 index），本 case 不对裸 ref 作任何断言。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, findRef, assertExtractEquals } from "../_helpers.js";

const def: CaseDefinition = {
  name: "contract/ref-identity-across-snapshot",
  suite: "b",
  async run(ctx) {
    const obs1 = await ctx.call("vortex_observe", {});
    const ref1 = findRef(extractText(obs1), "Toggle");
    ctx.assert(ref1 !== null, "第 1 次 observe 应给出按钮 Toggle 的 ref");

    // 新快照：hash 变了（每次 observe 都发新快照）
    const obs2 = await ctx.call("vortex_observe", {});
    const ref2 = findRef(extractText(obs2), "Toggle");
    ctx.assert(ref2 !== null, "第 2 次 observe 应给出按钮 Toggle 的 ref");
    ctx.assert(
      ref1 !== ref2,
      `新 observe 应发布新快照的 ref（hash 不同），ref1=${ref1} ref2=${ref2}`,
    );

    // 用旧快照的 hashed ref 再 act 一次
    const act = await ctx.call("vortex_act", { action: "click", target: ref1 as string });
    const actText = extractText(act);
    const stale = /Error \[STALE_SNAPSHOT\]/.test(actText);

    if (stale) {
      // 结局 ①：响亮拒绝（身份被保住），hint 必须指引重新 observe
      ctx.assert(
        /vortex_observe/.test(actText),
        `STALE_SNAPSHOT 的 hint 应指引重新 observe，实际: ${actText.slice(0, 200)}`,
      );
    } else {
      // 结局 ②：仍命中同一元素（身份依然成立）
      await assertExtractEquals(ctx, "#toggle", "Toggled");
    }

    // 无论哪种结局，都不能改指别的元素：输入框必须还是空的
    await assertExtractEquals(ctx, "#name", "");

    // 新快照的 ref 必须命中同一个元素（快照内的身份映射是准的）
    const act2 = await ctx.call("vortex_act", { action: "click", target: ref2 as string });
    const act2Text = extractText(act2);
    ctx.assert(
      !/Error \[/.test(act2Text),
      `新快照的 ref 应命中按钮，实际: ${act2Text.slice(0, 200)}`,
    );
  },
};
export default def;
