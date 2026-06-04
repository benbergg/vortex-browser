// el-select 单选：验证 vortex_fill kind=select 能直接落值。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-select-single",
  playgroundPath: "/#/el-select-single",
  tier: "medium",
  async run(ctx) {
    // 直接使用 vortex_fill with kind=select
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"target-select\"]",
      kind: "select",
      value: "Option B"
    });

    // 验证：v-model 是 value 'B'，result 区显示 "选中值：B"
    await assertResultContains(ctx, "选中值：B");
  },
};

export default def;
