// 失败路径 · ref 生命周期（suite B 1/7）：hashed ref 跨调用存活。
//
// 契约：observe 发布的 hashed ref（@<hash>:eN）在后续调用里**保持有效** ——
// 拿它去 act 就是命中同一个元素；而一次**解析失败**（当前快照里不存在的 index）
// 不得污染已发布的 ref：失败之后同一个 ref 仍要能命中同一个元素。
// 反例（要防的 regression）：一次坏 ref 让 ref store 写坏，随后所有 act 都失灵。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, findRef, assertExtractEquals } from "../_helpers.js";

const def: CaseDefinition = {
  name: "contract/ref-survives-round",
  suite: "b",
  async run(ctx) {
    const obs = await ctx.call("vortex_observe", {});
    const snapshot = extractText(obs);
    const ref = findRef(snapshot, "Toggle");
    ctx.assert(ref !== null, `observe 应给出按钮 "Toggle" 的 ref，实际快照: ${snapshot.slice(0, 200)}`);
    ctx.assert(
      /^@[a-f0-9]{4}:/.test(ref as string),
      `observe 发布的应是 hashed ref（@<hash>:eN），实际: ${ref}`,
    );

    // 第 1 轮：act 命中 observe 给的 ref
    const click1 = await ctx.call("vortex_act", { action: "click", target: ref as string });
    const click1Text = extractText(click1);
    ctx.assert(
      !/Error \[/.test(click1Text),
      `第 1 轮 act 应命中已发布 ref，实际: ${click1Text.slice(0, 200)}`,
    );
    await assertExtractEquals(ctx, "#toggle", "Toggled");

    // 制造一次**解析失败**：当前快照里不存在的 index（hash 取当前快照的）
    const hash = (ref as string).slice(1, 5);
    const bad = await ctx.call("vortex_act", {
      action: "click",
      target: `@${hash}:e9999`,
      options: { timeout: 2000 },
    });
    const badText = extractText(bad);
    ctx.assert(/Error \[/.test(badText), `坏 index 应解析失败，实际: ${badText.slice(0, 200)}`);

    // 第 2 轮：解析失败之后，已发布的 ref 仍要能命中（不被污染）
    const click2 = await ctx.call("vortex_act", { action: "click", target: ref as string });
    const click2Text = extractText(click2);
    ctx.assert(
      !/Error \[/.test(click2Text),
      `解析失败不应污染已发布 ref，实际: ${click2Text.slice(0, 200)}`,
    );
    // 命中的还是同一个元素（文本再切回初始值）
    await assertExtractEquals(ctx, "#toggle", "Toggle");
  },
};
export default def;
