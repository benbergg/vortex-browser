// Fixture-based: playground/public/jd-review-modal.html mirrors JD's review
// modal pattern. NOT a live jd.com test.
// RM-05: 切「图/视频」keyword tag —— P1 fix 在 keyword tag 上的延伸验证。
// 关键测点：
//   - "图/视频5000+" tag 是 keyword 组（与 sentiment "差评200+" 同 class）
//   - P1 fix 后 observe 应输出完整 ancestor 文本而非 inner span
//   - click 后数据集换成 photo dataset（用户名 p***N + "图/视频评价" 文本）

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-review-rm-05-photo-tag",
  playgroundPath: "/jd-review-modal.html",
  tier: "medium",
  async run(ctx) {
    // open modal
    const s0 = extractText(await ctx.call("vortex_observe", {}));
    // v0.8 hashed ref support: @\w+ doesn't match the ':' in @<hash>:eN, so widen to [\w:]+
    const triggerRef = s0.match(/(@[\w:]+)\s+\[\w+\]\s+"全部评价"/)?.[1];
    await ctx.call("vortex_act", { target: triggerRef!, action: "click" });
    await new Promise((r) => setTimeout(r, 300));

    // 找「图/视频」 ref —— P1 fix 后应能拿到完整文本 "图/视频5000+"
    const s1 = extractText(await ctx.call("vortex_observe", {}));
    const photoMatch = s1.match(/(@[\w:]+)\s+\[\w+\]\s+"图\/视频5000\+"/);
    ctx.assert(
      photoMatch !== null,
      `应找到「图/视频5000+」完整文本 ref（验 P1 fix）：${s1.slice(0, 600)}`,
    );
    ctx.recordMetric("keywordTagFullText", 1);

    await ctx.call("vortex_act", { target: photoMatch![1], action: "click" });
    await new Promise((r) => setTimeout(r, 400));

    // 切换后列表应显示 photo dataset（用户名 p***N + 图/视频评价）
    const list = extractText(await ctx.call("vortex_extract", {
      target: "._rateListContainer_1ygkr_45",
    }));
    ctx.recordMetric("photoListBytes", list.length);

    const photoUserCount = (list.match(/p\*\*\*\d/g) ?? []).length;
    ctx.recordMetric("photoUsers", photoUserCount);
    ctx.assert(
      photoUserCount >= 6,
      `photo dataset 应至少 6 个 p***N 用户（初始 8 items），实际 ${photoUserCount}`,
    );
    ctx.assert(
      /图\/视频评价/.test(list),
      `photo 数据应含 "图/视频评价" 文本：${list.slice(0, 400)}`,
    );
  },
};

export default def;
