// el-select 多选 + tag：验证 vortex_fill kind=select value=[...] 能否一次写多个。
// 预期和 el-select-single 同因失败，走兜底（连续点击 2 个选项）。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-select-multiple",
  playgroundPath: "/#/el-select-multiple",
  tier: "medium",
  async run(ctx) {
    // 直接使用 vortex_fill with kind=select
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"target-select-multiple\"]",
      kind: "select",
      value: ["Option A", "Option C"]
    });

    await assertResultContains(ctx, "A");
    await assertResultContains(ctx, "C");
  },
};

export default def;
