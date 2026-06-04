// el-input-number：数字输入。Element Plus 包了 native input + 上下按钮。
// 试 vortex_type 直接键入数字，观察 v-model 同步。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-input-number",
  playgroundPath: "/#/el-input-number",
  tier: "medium",
  async run(ctx) {
    // 先 click 拿 focus（el-input-number 默认空，type 前需要 focus）
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-input-number\"] input"
    });
    await ctx.call("vortex_act", {
      action: "type",
      target: "[data-testid=\"target-input-number\"] input",
      text: "42"
    });
    // blur 触发 commit（el-input-number 在 blur 时 clamp + emit change）
    await ctx.call("vortex_press", { key: "Tab" });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1000
    });

    await assertResultContains(ctx, "num=42");
  },
};

export default def;
