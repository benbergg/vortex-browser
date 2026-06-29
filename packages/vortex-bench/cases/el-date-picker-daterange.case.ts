// el-date-picker daterange（无 time）：datetimerange 的对照组。
// 两者都跨月，若都失败 → driver 共享 bug；若 daterange 过而 datetimerange 失败 → 是 datetime 特有。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const START = "2024-01-01";
const END = "2024-01-31";

const def: CaseDefinition = {
  name: "el-date-picker-daterange",
  playgroundPath: "/#/el-date-picker-daterange",
  tier: "medium",
  async run(ctx) {
    let fillOk = false;
    let fillText = "";
    try {
      const res = await ctx.call("vortex_fill", {
        target: "[data-testid=\"target-daterange\"] .el-date-editor.el-range-editor",
        widget: "daterange",
        value: { start: START, end: END }
      });
      fillText = extractText(res);
      fillOk = !fillText.toLowerCase().includes("error") && !fillText.includes("INVALID_PARAMS");
    } catch (err) {
      fillText = err instanceof Error ? err.message : String(err);
      fillOk = false;
    }

    ctx.assert(fillOk, `vortex_fill kind=daterange 失败: ${fillText.slice(0, 300)}`);
    await assertResultContains(ctx, `start=${START}`);
    await assertResultContains(ctx, `end=${END}`);
  },
};

export default def;
