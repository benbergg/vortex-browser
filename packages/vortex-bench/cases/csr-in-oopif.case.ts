// 缺口 E — closed shadow ⊂ 跨源 OOPIF,不可达的诚实契约。镜像 Stagehand csr_in_oopif。
// 实测确诊(2026-06-04):closed shadow 内按钮即便在跨源帧内也不可达(Web 平台设计,
// shadowRoot=null,querySelectorAllDeep 进不去 closed root)→ observe 不 surface 该按钮、
// act 走 ref 应明确报错。本 case 锁"不静默假成功"契约(对比 oopif-in-csr:iframe 内容
// 可达,但 shadow 内的普通元素不可达——边界在"是不是帧",不在"在不在 shadow")。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "csr-in-oopif",
  playgroundPath: "/synth/csr-in-oopif.html",
  tier: "hard",
  async run(ctx) {
    // 1. observe 不应 surface closed-shadow 内按钮(不可达)。
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    const ref = findRef(snap, "closed-shadow按钮");
    ctx.assert(
      ref === null,
      `closed shadow 内元素(即便在 OOPIF 内)不应被 observe surface。snapshot:\n${snap.slice(0, 500)}`,
    );
    // 2. 直接 selector act 也应明确报错,不静默假成功。
    let errored = false;
    let detail = "";
    try {
      const res = await ctx.call("vortex_act", {
        action: "click",
        target: "#sbtn",
        options: { timeout: 1500 },
      });
      detail = extractText(res);
      errored = Boolean((res as { isError?: boolean }).isError) || /Error \[[A-Z_]+\]/.test(detail);
    } catch (e) {
      errored = true;
      detail = e instanceof Error ? e.message : String(e);
    }
    ctx.assert(errored, `closed shadow 内元素 act 应明确报错(不可达),实际无错误: ${detail.slice(0, 200)}`);
  },
};
export default def;
