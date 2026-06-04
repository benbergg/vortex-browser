// el-drawer：抽屉滑出后在内部 input 输入。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-drawer",
  playgroundPath: "/#/el-drawer",
  tier: "medium",
  async run(ctx) {
    // 1. 点触发按钮
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-drawer-trigger\"] button"
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1500
    });

    // 2. 在抽屉内输入（先 click focus，避免 drawer transition 期间 type 打偏）
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"drawer-input\"] input"
    });
    await ctx.call("vortex_act", {
      action: "type",
      target: "[data-testid=\"drawer-input\"] input",
      text: "test-content"
    });

    await assertResultContains(ctx, "drawerOpen=true");
    await assertResultContains(ctx, "inside=test-content");
  },
};

export default def;
