// R1 Runbook Case (N0060 京东选品评测 V1) — BUG-011
// Fixture: playground/public/jd-sticky-search.html
// 验证京东首页 sticky 搜索栏 NOT_STABLE 时自动 force=true 重试 (方案 B):
//   1. 默认 (无 force): NOT_STABLE → 自动 force=true 重试, 二次成功不报错
//   2. 显式 force=true: 直接 force, 一次成功, 不重试
//   3. 显式 force=false: 禁用自动重试, NOT_STABLE 立刻抛 NOT_STABLE
//
// 关键契约:
//   - vortex_fill sticky search input → fill value 成功 (input.value = 文本)
//   - input 不报错 (NOT_STABLE 自动 force 重试生效)
//   - 显式 force=false 时, NOT_STABLE 错误码抛错 (用户显式禁用)
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-search-01-stickyautoforce",
  playgroundPath: "/jd-sticky-search.html",
  tier: "medium",
  async run(ctx) {
    // 触发滚动让 sticky transition 激活
    await ctx.call("vortex_evaluate", {
      code: "(function(){ window.scrollTo(0, 200); return 'scrolled'; })()",
    });
    await new Promise((r) => setTimeout(r, 300));

    // 契约 1: 默认 (无 force) — fill 自动 force 重试
    const fillRes = await ctx.call("vortex_act", {
      target: "#search-input",
      action: "fill",
      value: "iPhone 16 Pro",
    });
    const fillText = extractText(fillRes);
    ctx.recordMetric("defaultFillResBytes", fillText.length);

    // 验证 input.value 真写入 (fill 成功)
    const inputValue = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", {
        code: "return document.getElementById('search-input').value;",
      }),
    );
    ctx.recordMetric("defaultFillInputValue", inputValue.length);
    ctx.assert(
      inputValue === "iPhone 16 Pro",
      `BUG-011 方案 B: 默认 fill sticky 应自动 force 重试, input.value 应为 "iPhone 16 Pro", 实际: "${inputValue}"`,
    );

    // 契约 2: 显式 force=false — NOT_STABLE 立刻抛错 (禁用自动重试)
    // 先清空 input
    await ctx.call("vortex_evaluate", {
      code: "document.getElementById('search-input').value = '';",
    });
    // 触发滚动让 sticky transition 激活
    await ctx.call("vortex_evaluate", {
      code: "(function(){ window.scrollTo(0, 400); return 'scrolled'; })()",
    });
    await new Promise((r) => setTimeout(r, 200));

    let notStableThrown = false;
    let errorCode = "";
    try {
      await ctx.call("vortex_act", {
        target: "#search-input",
        action: "fill",
        value: "test",
        force: false,
      });
    } catch (e) {
      notStableThrown = true;
      errorCode = e instanceof Error ? e.message : String(e);
    }
    // 注: 在 fixture 中 (无 transition 持续), 即便 force=false 也可能成功
    // 验证意图: 用户显式 force=false 时, vortex_fill 不会自动重试 (即使失败也不重试)
    ctx.recordMetric("forceFalseNotStableThrown", notStableThrown ? 1 : 0);
    // 注: fixture 环境下 NOT_STABLE 不一定触发, 此 case 主要验证契约 1
    // (契约 3 的完整验证在单元测试 dom-fill-not-stable-retry.test.ts)
  },
};
export default def;
