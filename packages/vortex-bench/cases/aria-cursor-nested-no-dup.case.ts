// 验证 Fix A 跨池 ancestor short-circuit：ARIA 外层（menuitem/label/button）
// 包 cursor:pointer 子时，cursor:pointer fallback 应跳过整个 ARIA 子树，
// 避免 LLM 看到同一可点项两次（dual-instance）。
//
// 同时测控制场景 4：bytenew 风格的 cursor:pointer li（无 ARIA）必须照旧被收。

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "aria-cursor-nested-no-dup",
  playgroundPath: "/aria-cursor-nested.html",
  tier: "medium",
  async run(ctx) {
    await new Promise((r) => setTimeout(r, 300));
    const snap = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("totalRefBytes", snap.length);

    // 1. menubar：3 menuitem 必出，不应有 [div] "首页"/"商品"/"订单" 副本
    const menuitems = (snap.match(/\[menuitem\]\s+"(首页|商品|订单)"/g) ?? []);
    ctx.assert(menuitems.length === 3, `应有 3 个 [menuitem] (首页/商品/订单)，实际 ${menuitems.length}`);
    ctx.assert(
      !/\[div\]\s+"首页"/.test(snap) &&
      !/\[div\]\s+"商品"/.test(snap) &&
      !/\[div\]\s+"订单"/.test(snap),
      `menuitem 内层 div 不应作为 [div] 重复输出：${snap}`,
    );

    // 2. radio group：3 label 必出，不应有 [span] "好评"/"中评"/"差评" 副本
    const labels = (snap.match(/\[label\]\s+"(好评|中评|差评)"/g) ?? []);
    ctx.assert(labels.length === 3, `应有 3 个 [label] sentiment，实际 ${labels.length}`);
    ctx.assert(
      !/\[span\]\s+"好评"/.test(snap) &&
      !/\[span\]\s+"中评"/.test(snap) &&
      !/\[span\]\s+"差评"/.test(snap),
      `label 内层 span 不应作为 [span] 重复输出：${snap}`,
    );

    // 3. button：2 button 必出，不应有 [span] "确定"/"取消" 副本
    const buttons = (snap.match(/\[button\]\s+"(确定|取消)"/g) ?? []);
    ctx.assert(buttons.length === 2, `应有 2 个 [button]，实际 ${buttons.length}`);
    ctx.assert(
      !/\[span\]\s+"确定"/.test(snap) &&
      !/\[span\]\s+"取消"/.test(snap),
      `button 内层 span 不应作为 [span] 重复输出：${snap}`,
    );

    // 4. 控制：bytenew 风格 cursor:pointer li（无 ARIA）必出
    ctx.assert(
      /纯 cursor:pointer 1/.test(snap),
      `场景 A（无 ARIA）的 cursor:pointer li 不能被误杀：${snap.slice(0, 800)}`,
    );
    ctx.assert(
      /纯 cursor:pointer 2/.test(snap),
      `场景 A 第 2 个 cursor:pointer li 不能被误杀`,
    );

    ctx.recordMetric("ariaItems", menuitems.length + labels.length + buttons.length);
  },
};

export default def;
