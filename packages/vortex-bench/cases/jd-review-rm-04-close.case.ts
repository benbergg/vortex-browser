// Fixture-based: playground/public/jd-review-modal.html mirrors JD's review
// modal pattern. NOT a live jd.com test.
// RM-04: 关闭弹窗 —— div+cursor:pointer 的 close icon
// 关键测点：
//   - 关闭 div（无 role 无 aria-label）能被 vortex 收到
//   - Escape 键关闭兜底（vortex_press）
//   - 关闭后 observe 不应再含弹窗内 tag

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "jd-review-rm-04-close",
  playgroundPath: "/jd-review-modal.html",
  tier: "medium",
  async run(ctx) {
    // open modal
    const s0 = extractText(await ctx.call("vortex_observe", {}));
    // v0.8 hashed ref support: @\w+ doesn't match the ':' in @<hash>:eN, so widen to [\w:]+
    const triggerRef = s0.match(/- \w+ "全部评价"\s+\[ref=(@[\w:]+)\]/)?.[1];
    await ctx.call("vortex_act", { target: triggerRef!, action: "click" });
    await new Promise((r) => setTimeout(r, 500));

    // 弹窗已开（observe 应见 close icon name="closeIcon"）
    const sOpen = extractText(await ctx.call("vortex_observe", {}));
    ctx.assert(/closeIcon/.test(sOpen), `弹窗未打开（observe 不含 closeIcon）：${sOpen.slice(0, 300)}`);

    // P3 fix: close icon 是 div+cursor:pointer + svg-only（无文本无 aria-label），
    // icon-only fallback 从 class 抽取 "closeIcon" 作 name → ref 可被找到
    const s2 = extractText(await ctx.call("vortex_observe", {}));
    const closeMatch = s2.match(/- \w+ "closeIcon"\s+\[ref=(@[\w:]+)\]/);
    ctx.assert(closeMatch !== null, `P3 fix 应让 close icon (svg-only) 被收集 name="closeIcon"：${s2.slice(0, 500)}`);
    await ctx.call("vortex_act", { target: closeMatch![1], action: "click" });
    await new Promise((r) => setTimeout(r, 400));

    // observe 过滤 hidden 元素：关闭后 modal 内 ref 应都不再出现
    const s3 = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("afterCloseObsBytes", s3.length);
    ctx.assert(!/closeIcon/.test(s3), `observe 仍含 closeIcon，弹窗未关闭：${s3.slice(0, 400)}`);
    ctx.assert(!/200\+/.test(s3), `observe 仍含弹窗内 tag，弹窗未关闭`);
    ctx.recordMetric("closeIconClickWorked", 1);

    // 副路径：Escape 兜底测试（指标记录，不 fail）
    await ctx.call("vortex_act", { target: triggerRef!, action: "click" });
    await new Promise((r) => setTimeout(r, 300));
    await ctx.call("vortex_press", { key: "Escape" });
    await new Promise((r) => setTimeout(r, 300));
    const s4 = extractText(await ctx.call("vortex_observe", {}));
    const escapeWorked = !/closeIcon/.test(s4);
    ctx.recordMetric("escapeKeyWorked", escapeWorked ? 1 : 0);
  },
};

export default def;
