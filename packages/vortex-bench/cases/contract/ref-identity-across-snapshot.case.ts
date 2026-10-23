// 失败路径 · ref 身份（suite B 2/7）：跨快照的 ref 身份安全。
//
// 契约（父会话 2026-10-23 修正后的表述 —— 原表述"仍指向同一元素"过窄）：
// 跨快照再用旧 ref 时，要保证的安全性质是 **旧 ref 不得静默命中错误元素**。
// 允许且仅允许两种**具体**结果：
//   (a) 旧 hashed ref 仍然命中原元素 → 断言原元素（按钮文本）确实变化；
//   (b) 运行时明确拒绝（具体的错误码 STALE_SNAPSHOT）→ 断言该错误形态。
// "任意错误 / 任意失败"**不算**通过 —— 必须是上面两种具体形态之一。
//
// 本 case 只用 hashed ref（@<hash>:eN）：helper 也会返回裸 ref（@eN），
// 裸 ref 没有身份锚（observe 会重排 index），所以这里显式限定并断言其形态。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, findRef, assertExtractEquals } from "../_helpers.js";

/** hashed ref 的形态：@<4位hex hash>:e<index> */
const HASHED_REF_RE = /^@[a-f0-9]{4}:e\d+$/;

const def: CaseDefinition = {
  name: "contract/ref-identity-across-snapshot",
  suite: "b",
  async run(ctx) {
    const obs1 = await ctx.call("vortex_observe", {});
    const ref1 = findRef(extractText(obs1), "Toggle");
    ctx.assert(ref1 !== null, "第 1 次 observe 应给出按钮 Toggle 的 ref");
    ctx.assert(
      HASHED_REF_RE.test(ref1 as string),
      `本 case 只用 hashed ref（@<hash>:eN），实际: ${ref1}`,
    );

    // 新快照：hash 变了（每次 observe 都发新快照）
    const obs2 = await ctx.call("vortex_observe", {});
    const ref2 = findRef(extractText(obs2), "Toggle");
    ctx.assert(ref2 !== null, "第 2 次 observe 应给出按钮 Toggle 的 ref");
    ctx.assert(
      HASHED_REF_RE.test(ref2 as string),
      `本 case 只用 hashed ref（@<hash>:eN），实际: ${ref2}`,
    );
    ctx.assert(
      ref1 !== ref2,
      `新 observe 应发布新快照的 ref（hash 不同），ref1=${ref1} ref2=${ref2}`,
    );

    // 用旧快照的 hashed ref 再 act 一次
    const act = await ctx.call("vortex_act", { action: "click", target: ref1 as string });
    const actText = extractText(act);
    const rejected =
      Boolean((act as { isError?: boolean }).isError) || /^Error \[[A-Z_]+\]:/m.test(actText);

    if (rejected) {
      // (b) 运行时明确拒绝：必须是**具体的** STALE_SNAPSHOT 形态（任意错误不算通过）
      ctx.assert(
        /^Error \[STALE_SNAPSHOT\]:/m.test(actText),
        `旧 hashed ref 被拒时必须是具体的 STALE_SNAPSHOT 形态，实际: ${actText.slice(0, 200)}`,
      );
      ctx.assert(
        /vortex_observe/.test(actText),
        `STALE_SNAPSHOT 的 hint 应指引重新 observe，实际: ${actText.slice(0, 200)}`,
      );
    } else {
      // (a) 仍然命中原元素：原元素确实变化（按钮文本从 Toggle 变成 Toggled）
      await assertExtractEquals(ctx, "#toggle", "Toggled");
    }

    // 两种结局都不许"静默改指别的元素"：输入框必须还是空的
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
