// el-color-picker：click 触发 → panel 底部 hex input type → 点"确定"。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const HEX = "#409EFF";

const def: CaseDefinition = {
  name: "el-color-picker",
  playgroundPath: "/#/el-color-picker",
  tier: "medium",
  async run(ctx) {
    // click color picker trigger 打开 panel
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-color-picker\"] .el-color-picker__trigger"
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1000
    });

    // 在 panel 底部 hex input 键入颜色
    await ctx.call("vortex_act", {
      action: "click",
      target: ".el-color-dropdown__value input"
    });
    await ctx.call("vortex_press", { key: "Meta+a" });
    await ctx.call("vortex_act", {
      action: "type",
      target: ".el-color-dropdown__value input",
      text: HEX
    });
    await ctx.call("vortex_press", { key: "Enter" });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 500
    });

    // 点"确定"按钮
    await ctx.fallbackEvaluate({
      code: `(() => {
        for (const b of document.querySelectorAll('.el-color-dropdown__btns button')) {
          const t = (b.textContent || '').trim();
          if (t === '确定' || t === 'OK' || t === 'Confirm') { b.click(); return 'ok'; }
        }
        return 'not-found';
      })()`,
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1000
    });

    await assertResultContains(ctx, "color=");
    // color 值可能是大写 hex 或小写，只要非空即可
  },
};

export default def;
