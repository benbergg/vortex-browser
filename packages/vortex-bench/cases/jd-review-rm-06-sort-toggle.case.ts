// Fixture-based: playground/public/jd-review-modal.html mirrors JD's review
// modal pattern. NOT a live jd.com test.
// RM-06: 排序切换 —— sort label 是 div+cursor:pointer，含 is-active class。
// 关键测点：
//   - 初始 "最新" [active]，"当前商品" 无 [active]
//   - click "当前商品" 后 active state 互斥切换
//   - vortex observe state.active 检测 (`is-active` / `aria-pressed=true`)

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-review-rm-06-sort-toggle",
  playgroundPath: "/jd-review-modal.html",
  tier: "medium",
  async run(ctx) {
    // open modal
    const s0 = extractText(await ctx.call("vortex_observe", {}));
    // v0.8 hashed ref support: @\w+ doesn't match the ':' in @<hash>:eN, so widen to [\w:]+
    const triggerRef = s0.match(/- \w+ "全部评价"\s+\[ref=(@[\w:]+)\]/)?.[1];
    await ctx.call("vortex_act", { target: triggerRef!, action: "click" });
    await new Promise((r) => setTimeout(r, 300));

    // 初始 sort 状态：最新 [active]，当前商品 不 [active]
    const s1 = extractText(await ctx.call("vortex_observe", {}));
    const latestActive = /- \w+ "最新"[^\n]*\[active\]/.test(s1);
    ctx.assert(latestActive, `初始 "最新" 应有 [active] state：${s1.slice(0, 600)}`);

    const currentSkuMatch = s1.match(/- \w+ "当前商品"\s+\[ref=(@[\w:]+)\](?![^\n]*\[active\])/);
    ctx.assert(
      currentSkuMatch !== null,
      `初始 "当前商品" 不应 [active]：${s1.slice(0, 600)}`,
    );

    // click 当前商品
    await ctx.call("vortex_act", { target: currentSkuMatch![1], action: "click" });
    await new Promise((r) => setTimeout(r, 300));

    // 验证 active 切换：当前商品 [active]，最新 不再 [active]
    const s2 = extractText(await ctx.call("vortex_observe", {}));
    ctx.assert(
      /- \w+ "当前商品"[^\n]*\[active\]/.test(s2),
      `切换后 "当前商品" 应 [active]：${s2.slice(0, 600)}`,
    );
    ctx.assert(
      /- \w+ "最新"\s+\[ref=[@\w:]+\](?![^\n]*\[active\])/.test(s2),
      `切换后 "最新" 不应再 [active]：${s2.slice(0, 600)}`,
    );
    ctx.recordMetric("sortToggleVerified", 1);
  },
};

export default def;
