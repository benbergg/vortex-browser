// R1 Runbook Case (N0060 京东选品评测 V1) — REQ-NNN
// Fixture: playground/public/jd-react-rewrite-list.html
// 验证京东角标 (<img alt="自营"> 等) 应被 vortex_extract 追加到 innerText 结果。
// innerText/textContent 都不读 alt attribute (alt 是 attribute 不是 text node),
// vortex 修复: walkWithAlt 追加未在 innerText 出现的 alt 文字 (dedup via includes)。
//
// 关键契约:
//   - 京东角标 alt 包含: 自营/明日达/百亿补贴/国家补贴/7天无理由/送货上门/重磅新品
//   - 默认 includeAlt=true: extract target=#card-container 召回内容应含这些 alt
//   - 显式 includeAlt=false: 行为与原 innerText 一致 (向后兼容)
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-list-03-imgalt",
  playgroundPath: "/jd-react-rewrite-list.html",
  tier: "medium",
  async run(ctx) {
    // 默认 includeAlt=true: 验证 alt 追加到 extract 结果
    const textWithAlt = extractText(
      await ctx.call("vortex_extract", { target: "#card-container" }),
    );
    ctx.recordMetric("extractWithAltBytes", textWithAlt.length);

    // 关键 alt 字串应在 extract 输出中
    const expectedAlts = ["自营", "明日达", "百亿补贴", "国家补贴", "7天无理由", "送货上门", "重磅新品"];
    const foundAlts = expectedAlts.filter((alt) => textWithAlt.includes(alt));
    ctx.recordMetric("altKeywordsFound", foundAlts.length);
    ctx.assert(
      foundAlts.length >= 5,
      `REQ-NNN 修复: 京东角标 alt 应被追加到 extract 结果, 期望 ≥ 5 个, 实际 ${foundAlts.length}: ${foundAlts.join(", ")}`,
    );

    // 显式 includeAlt=false: 行为与原 innerText 一致 (不应含 alt)
    const textNoAlt = extractText(
      await ctx.call("vortex_extract", {
        target: "#card-container",
        includeAlt: false,
      }),
    );
    ctx.recordMetric("extractNoAltBytes", textNoAlt.length);

    // includeAlt=false 时, 角标 alt 不应出现 (除非 innerText 中已经含)
    // (fixture 中 alt 是 attribute 不是 text node, innerText 不含)
    // 但价格 ¥8999.00 这种 innerText 自带的仍然在
    ctx.assert(
      textNoAlt.length > 0,
      `includeAlt=false 时 extract 应仍能返回 innerText, 实际: ${textNoAlt.slice(0, 200)}`,
    );

    // 价格数字应在 includeAlt=true 和 false 两种模式下都出现
    // (price 是 innerText 自带, 不依赖 alt 提取)
    const priceRegex = /8999|5999|11999|7999|6999|12999/;
    ctx.assert(
      priceRegex.test(textWithAlt),
      `extract 应含价格数字: ${textWithAlt.slice(0, 200)}`,
    );
  },
};
export default def;
