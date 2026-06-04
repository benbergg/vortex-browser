// el-time-picker：用 fill kind=time（CDP 打开 panel + spinner 列 click + 确定）
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const TIME = "14:30:45";

const def: CaseDefinition = {
  name: "el-time-picker",
  playgroundPath: "/#/el-time-picker",
  tier: "medium",
  async run(ctx) {
    await ctx.call("vortex_act", {
      action: "fill",
      target: "[data-testid=\"target-time-picker\"] input",
      kind: "time",
      value: TIME
    });
    await assertResultContains(ctx, `time=${TIME}`);
  },
};

export default def;
