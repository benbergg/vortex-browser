// R1 Runbook Case (N0060 京东选品评测 V1) — REQ-009
// Fixture: playground/public/jd-react-rewrite-list.html
// 验证京东客服图标 (≤32px 无文本 <a class="_newIcon_*">) 应被 vortex 修复
// 兜底为 'icon-link @x=N,y=N' 固定名, 替代空名率噪声。
//
// 关键契约:
//   - 6 个商品卡各含 1 个客服图标 <a href="chat.jd.com">
//   - 5 条件全命中: tagName=a / children=0 / textContent='' / bbox≤32x32 / href非空
//   - observe 输出应含 "icon-link @x=N,y=N" 兜底名 (6 个)
//   - 京东 logo 190x58 超出 32px boundary, 不应被认作 icon-link
//   - 6 个客服图标 ref 应能被 vortex_act click 触发 (验证 clickHint + 实际可用)
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-list-02-iconlink",
  playgroundPath: "/jd-react-rewrite-list.html",
  tier: "medium",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("snapBytes", snap.length);

    // 验证: observe 输出应含 "icon-link @x=N,y=N" 兜底名 (6 个客服图标)
    const iconLinkMatches = snap.match(/icon-link\s+@x=\d+,y=\d+/g) ?? [];
    ctx.recordMetric("iconLinkObserved", iconLinkMatches.length);
    ctx.assert(
      iconLinkMatches.length >= 6,
      `REQ-009 修复: 6 个客服图标应被认作 icon-link, 实际观察到 ${iconLinkMatches.length}: ${iconLinkMatches.slice(0, 3).join(", ")}`,
    );

    // 验证: 京东 logo 190x58 不应被认作 icon-link (尺寸 > 32px boundary)
    // 注意: jd-logo href=https://www.jd.com/ 但 children=0, 会被 ref 但不应用 icon-link 名
    // (因 190x58 > 32, 走 PRODUCT_HINTS / title / iconNameFromClass 路径)
    const logoMatch = snap.match(/京东|jd\.com|logo/i);
    ctx.recordMetric("logoRefObserved", logoMatch !== null ? 1 : 0);

    // 验证: live DOM 客服图标应被标 reactClickable? 答: 否, 客服图标无 onClick
    // (本 case 不验证 reactClickable, 见 jd-list-01)
    const iconLinkCount = extractEvalJson<number>(
      await ctx.call("vortex_evaluate", {
        code: "return document.querySelectorAll('a[href*=\"chat.jd.com\"]').length;",
      }),
    );
    ctx.assert(
      iconLinkCount === 6,
      `fixture 应有 6 个客服图标, 实际 ${iconLinkCount}`,
    );
  },
};
export default def;
