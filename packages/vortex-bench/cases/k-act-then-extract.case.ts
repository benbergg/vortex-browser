// 缺口 K — 多步状态依赖。act 点击展开 → extract 读新出现的内容。
// 镜像 Stagehand combination(act 改状态后 extract)。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, assertExtractContainsAll } from "./_helpers.js";

const def: CaseDefinition = {
  name: "k-act-then-extract",
  playgroundPath: "/synth/k-act-then-extract.html",
  tier: "medium",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const ref = findRef(snap, "显示详情");
    ctx.assert(ref !== null, `observe 应暴露"显示详情"按钮。snapshot:\n${snap.slice(0, 300)}`);
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 1000 });
    // 点击前 detail display:none(extract 取不到);点击后显示 → 应含 SECRET-42。
    await assertExtractContainsAll(ctx, '[data-testid="detail"]', ["SECRET-42"]);
  },
};
export default def;
