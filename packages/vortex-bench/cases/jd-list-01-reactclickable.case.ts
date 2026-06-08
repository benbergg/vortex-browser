// R1 Runbook Case (N0060 京东选品评测 V1) — BUG-010
// Fixture: playground/public/jd-react-rewrite-list.html
// 验证京东商品卡 React 重写后无 <a> 详情链接, vortex 修复后:
//   1. observe 标 data-vortex-react-clickable (3 条件任一命中)
//   2. click 自动走 CDP 真实 mouse (isTrusted=true) 触发跳转
//   3. clickResult data-testid 反馈被点击的 SKU (fixture 内 listener 验证)
//
// 关键契约:
//   - observe 后, 商品卡 div 应被标 data-vortex-react-clickable="1"
//   - click 商品卡 → click-result 应含 sku 编号 (验证事件触发)
//   - 整张卡是 div + onClick 桩, 合成 click (isTrusted=false) 在 React 真站
//     会被拦截, 本 fixture 用 vanilla listener 接受以观测 (fixture 限制说明)
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-list-01-reactclickable",
  playgroundPath: "/jd-react-rewrite-list.html",
  tier: "medium",
  async run(ctx) {
    // 触发 observe (会跑 observe emit 阶段, 标 reactClickable dataset)
    const snap = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("snapBytes", snap.length);

    // 验证 observe 抓到了商品卡 (整张 div 应有 accessible name 含 title)
    ctx.assert(
      /Apple iPhone 16 Pro 256GB/.test(snap),
      `observe 应含第一张商品卡 title: ${snap.slice(0, 500)}`,
    );

    // 关键验证: live DOM 上, 商品卡 div 应被标 data-vortex-react-clickable="1"
    const markedCount = extractEvalJson<number>(
      await ctx.call("vortex_evaluate", {
        code: "return document.querySelectorAll('[data-vortex-react-clickable=\"1\"]').length;",
      }),
    );
    ctx.recordMetric("reactClickableMarkedCount", markedCount);
    ctx.assert(
      markedCount >= 6,
      `BUG-010 修复: 商品卡应被标 reactClickable (期望 ≥ 6, 实际 ${markedCount})`,
    );

    // 验证 click 行为: 找第一张卡 (iPhone 16 Pro 256GB) 的 ref, click → 反馈 SKU
    const cardMatch = snap.match(/(@[\w:]+)\s+\[\w+\]\s+"Apple iPhone 16 Pro 256GB[^"]*"/);
    ctx.assert(
      cardMatch !== null,
      `应找到第一张商品卡的 ref: ${snap.slice(0, 600)}`,
    );
    const cardRef = cardMatch![1];

    // click 商品卡 (vortex 修复后, reactClickable 自动走 CDP real mouse)
    await ctx.call("vortex_act", { target: cardRef, action: "click" });
    await new Promise((r) => setTimeout(r, 400));

    // 验证 click-result 含 sku 1000001
    const result = extractText(await ctx.call("vortex_extract", {
      target: "#click-result",
    }));
    ctx.recordMetric("clickResultText", result.length);
    ctx.assert(
      /sku=1000001/.test(result) || /iPhone 16 Pro 256GB/.test(result),
      `click 商品卡应触发 click-result 反馈, 实际: ${result.slice(0, 200)}`,
    );
  },
};
export default def;
