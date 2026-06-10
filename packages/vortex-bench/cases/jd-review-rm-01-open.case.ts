// Fixture-based: playground/public/jd-review-modal.html mirrors JD's review
// modal pattern. NOT a live jd.com test (which would be flaky and against ToS).
// RM-01: 打开 JD 评价弹窗（cursor:pointer div + portal 渲染）
// 关键测点：
//   - .all-btn 是 div + cursor:pointer，无 role —— vortex cursor:pointer fallback 应识别
//   - 弹窗渲染在 #rateList portal，跨 DOM 树仍可被 observe 抓到
//   - 双层 tag 都用 ._tag_rgt47_12 同 class，应该都是可点

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-review-rm-01-open",
  playgroundPath: "/jd-review-modal.html",
  tier: "medium",
  async run(ctx) {
    // 初始 observe — 应抓到 .all-btn（cursor:pointer 自定义可点）
    const snap1 = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("snap1Bytes", snap1.length);

    // .all-btn 应在 snap1 里有 ref（cursor:pointer fallback 收到）
    ctx.assert(
      /全部评价/.test(snap1),
      `主页 observe 应含 "全部评价" trigger：${snap1.slice(0, 600)}`,
    );

    // 取 ref 并 click
    // v0.8 hashed ref support: @\w+ doesn't match the ':' in @<hash>:eN, so widen to [\w:]+
    const matchTrigger = snap1.match(/- \w+ "全部评价"\s+\[ref=(@[\w:]+)\]/);
    ctx.assert(matchTrigger !== null, `应找到 "全部评价" 的 ref：${snap1.slice(0, 400)}`);
    const triggerRef = matchTrigger![1];

    await ctx.call("vortex_act", { target: triggerRef, action: "click" });
    await new Promise((r) => setTimeout(r, 300));

    // 弹窗打开后再 observe — 应含 "商品评价" 标题（但 v0.7 bug 可能拆 text）
    const snap2 = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("snap2Bytes", snap2.length);

    // 弹窗 modal title 用 extract 验证（绕开 observe 拆 leaf 的 bug）
    const title = extractText(await ctx.call("vortex_extract", { target: ".modal-title" }));
    ctx.assert(/商品评价/.test(title), `modal title 应含 "商品评价"，实际 ${title}`);

    // close icon (svg-only) 通过 P3 icon-only fallback 收为 name="closeIcon"
    ctx.assert(/closeIcon/.test(snap2), `observe 应含 close icon name="closeIcon"：${snap2.slice(0, 600)}`);

    // 验证至少能识别 sort buttons（最新 / 当前商品 — 这些是 div 文本无 inner span）
    ctx.assert(/最新/.test(snap2), `observe 应含 "最新" 排序`);
    ctx.assert(/当前商品/.test(snap2), `observe 应含 "当前商品" 排序`);

    // P1 fix verify：tag 现在应输出完整 ancestor 文本（"好评2万+" 而非 "2万+"）
    const tagFullMatches = (snap2.match(/全部96%好评|图\/视频5000\+|好评2万\+|差评200\+/g) ?? []);
    ctx.recordMetric("fullTagNamesObserved", tagFullMatches.length);
    ctx.assert(
      tagFullMatches.length >= 4,
      `P1 fix 应让 4 个完整 tag 文本可见，实际 ${tagFullMatches.length}：${snap2.slice(0, 600)}`,
    );
  },
};

export default def;
