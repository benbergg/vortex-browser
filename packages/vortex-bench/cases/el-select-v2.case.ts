// el-select-v2（虚拟滚动）：测前几条选项是否可达。
// 后续虚拟滚动跨屏定位是独立 case。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-select-v2",
  playgroundPath: "/#/el-select-v2",
  tier: "hard",
  async run(ctx) {
    // 直接使用 vortex_fill with kind=select
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"target-select-v2\"]",
      widget: "select",
      value: "Option 5"
    });

    await assertResultContains(ctx, "value=opt-5");
  },
};

export default def;
