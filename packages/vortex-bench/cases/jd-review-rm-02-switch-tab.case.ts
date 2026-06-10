// Fixture-based: playground/public/jd-review-modal.html mirrors JD's review
// modal pattern. NOT a live jd.com test.
// RM-02: 切到「差评」tab —— 数据集更新 + active class 切换
// 关键测点：
//   - 多个同 class（_tag_rgt47_12）的 tag，vortex 必须用 ref 精确点击「差评」
//   - 切换后 active state 应反映在 vortex output（_tag-active class）
//   - 差评数据含 "商家：" 商家回复 —— 验证数据更新

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-review-rm-02-switch-tab",
  playgroundPath: "/jd-review-modal.html",
  tier: "medium",
  async run(ctx) {
    // open modal
    const s0 = extractText(await ctx.call("vortex_observe", {}));
    // v0.8 hashed ref support: @\w+ doesn't match the ':' in @<hash>:eN, so widen to [\w:]+
    const triggerRef = s0.match(/- \w+ "全部评价"\s+\[ref=(@[\w:]+)\]/)?.[1];
    ctx.assert(triggerRef, "找不到全部评价 trigger");
    await ctx.call("vortex_act", { target: triggerRef!, action: "click" });
    await new Promise((r) => setTimeout(r, 300));

    // P1 fix 后：tag observe 输出完整 ancestor 文本（"差评200+"），可直接 ref click
    const s1 = extractText(await ctx.call("vortex_observe", {}));
    const badRefMatch = s1.match(/- \w+ "[^"]*差评[^"]*"\s+\[ref=(@[\w:]+)\]/);
    ctx.assert(badRefMatch !== null, `应找到含 "差评" 的 ref：${s1.slice(0, 600)}`);
    ctx.recordMetric("observeFoundBadTagAsLeaf", 1);

    // 用 ref 直点（验证 P1 fix 让 LLM 不再需 selector workaround）
    await ctx.call("vortex_act", { target: badRefMatch![1], action: "click" });
    await new Promise((r) => setTimeout(r, 400));

    // 差评 tab 切换后，列表应出现「商家：」回复 + b*** 用户名（fixture data）
    const s2 = extractText(await ctx.call("vortex_extract", { target: "._rateListContainer_1ygkr_45" }));
    ctx.recordMetric("listExtractBytes", s2.length);

    ctx.assert(/商家：/.test(s2), `差评列表应含 "商家：" 回复段：${s2.slice(0, 500)}`);
    ctx.assert(/b\*\*\*/.test(s2), `差评数据用户名应为 b***N：${s2.slice(0, 400)}`);
  },
};

export default def;
