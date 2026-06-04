// el-table 多选 + 展开行 + 行内操作：验证 vortex 能定位"第 N 行的某元素"。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-table",
  playgroundPath: "/#/el-table",
  tier: "medium",
  async run(ctx) {
    // 1. 勾选第 2 行（Bob）的 selection checkbox
    // el-table 的选择框在 tr 的第一列 .el-checkbox，body 行 selector：
    //   .el-table__body tr:nth-child(N) .el-checkbox__inner
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-table\"] .el-table__body tr:nth-child(2) .el-checkbox__inner"
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1000
    });

    // 2. 点第 2 行的"编辑 2"按钮
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-table\"] .el-table__body tr:nth-child(2) .el-button"
    });

    await assertResultContains(ctx, "selected=[2]");
    await assertResultContains(ctx, "edited=2");
  },
};

export default def;
