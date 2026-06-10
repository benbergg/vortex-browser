// R1 Runbook Case (N0060 京东选品评测 V1) — REQ-009 → V5 修订
// Fixture: playground/public/jd-react-rewrite-list.html
//
// 【V5 演进】原 REQ-009 要求京东客服图标 (≤32px 无文本 <a class="_newIcon_*">)
// 被兜底命名为 'icon-link @x=N,y=N'。V5「收集链让位门修复」(20260610 设计 v2)
// 改判:当客服 icon-link 位于**自身可点的内容卡**(_card cursor:pointer)内时,它是
// 冗余噪声且占 maxElements 预算挤掉商品卡(真实京东每卡 1 个客服 ×60),故**直接丢弃**
// 而非命名。独立(非卡内)icon-link 仍走兜底命名,REQ-009 对那类场景不变。
//
// 关键契约(V5):
//   - fixture 6 个商品卡 _card (cursor:pointer) 各含 1 个客服图标 <a href="chat.jd.com">
//   - 卡内客服 icon-link 被丢弃:observe 输出**不含** "icon-link @x=N,y=N" (0 个)
//   - 商品卡本体入池有名 (标题入 observe,验机制未误删卡)
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-list-02-iconlink",
  playgroundPath: "/jd-react-rewrite-list.html",
  tier: "medium",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("snapBytes", snap.length);

    // fixture sanity: 6 个客服图标确在 DOM (href=chat.jd.com)
    const iconLinkCount = extractEvalJson<number>(
      await ctx.call("vortex_evaluate", {
        code: "return document.querySelectorAll('a[href*=\"chat.jd.com\"]').length;",
      }),
    );
    ctx.assert(
      iconLinkCount === 6,
      `fixture 应有 6 个客服图标, 实际 ${iconLinkCount}`,
    );

    // V5 修订: 卡内客服 icon-link 被丢弃 (噪声 + 占预算), observe 输出不应含 icon-link 兜底名
    const iconLinkMatches = snap.match(/icon-link\s+@x=\d+,y=\d+/g) ?? [];
    ctx.recordMetric("iconLinkObserved", iconLinkMatches.length);
    ctx.assert(
      iconLinkMatches.length === 0,
      `V5: 卡内 6 个客服 icon-link 应被丢弃 (0 个 icon-link 名), 实际观察到 ${iconLinkMatches.length}: ${iconLinkMatches.slice(0, 3).join(", ")}`,
    );

    // 机制完整性: 丢客服后商品卡本体仍入池有名 (验未误删卡)
    ctx.assert(
      /Apple iPhone 16/.test(snap),
      `商品卡应入池有名 (含 "Apple iPhone 16"), snapshot: ${snap.slice(0, 400)}`,
    );
  },
};
export default def;
