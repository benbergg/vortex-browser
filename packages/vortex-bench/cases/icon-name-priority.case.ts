// P6 验证：iconNameFromClass 三级优先（svg title > img alt > className + denylist）
// - 框架前缀类（el-/ant-/van-）+ 通用泛词（icon/iconfont/wrapper）应被 denylist 过滤
// - svg <title> / img alt / svg aria-label 优先于 className 兜底
// - CSS Modules 合法命名（closeIcon 等）仍走 fallback 保留

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "icon-name-priority",
  playgroundPath: "/icon-name-priority.html",
  tier: "medium",
  async run(ctx) {
    await new Promise((r) => setTimeout(r, 300));
    const snap = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("totalRefBytes", snap.length);

    // 1. svg <title> > className（即使没 className 也优先 title）
    ctx.assert(
      /\[button\]\s+"关闭"/.test(snap),
      `场景 1：svg <title> 应作为 button name "关闭"：${snap}`,
    );

    // 2. img alt > className
    ctx.assert(
      /\[link\]\s+"GitHub"/.test(snap),
      `场景 2：img alt 应作为 link name "GitHub"：${snap}`,
    );

    // 3. svg aria-label > className
    ctx.assert(
      /\[button\]\s+"设置"/.test(snap),
      `场景 3：svg aria-label 应作为 button name "设置"：${snap}`,
    );

    // 4. framework prefix denylist：el-icon 应**不**入 ref
    ctx.assert(
      !/\[i\]\s+"el-icon"/.test(snap),
      `场景 4：el-icon 应被 denylist 过滤：${snap}`,
    );

    // 5. CSS-modules wrapped el-popover：trailing _ 处理 + denylist
    ctx.assert(
      !/"el-popover/.test(snap),
      `场景 5：el-popover_* 应被 denylist 过滤：${snap}`,
    );

    // 6. 合法 CSS Modules 名（closeIcon）应保留
    ctx.assert(
      /\[div\]\s+"closeIcon"/.test(snap),
      `场景 6：closeIcon 应保留作 name：${snap}`,
    );

    // 7. generic denylist (iconfont)
    ctx.assert(
      !/"iconfont"/.test(snap),
      `场景 7：iconfont 应被 denylist 过滤：${snap}`,
    );

    ctx.recordMetric("p6IconPrioritySnapBytes", snap.length);
  },
};

export default def;
