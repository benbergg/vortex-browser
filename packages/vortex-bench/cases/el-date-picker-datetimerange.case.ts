// el-date-picker datetimerange：验证 vortex_fill kind=datetimerange value={start,end}。
// v0.5 曾踩过坑（已修），此 case 作为回归哨兵。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const START = "2024-01-01 00:00:00";
const END = "2024-01-31 23:59:59";

const def: CaseDefinition = {
  name: "el-date-picker-datetimerange",
  playgroundPath: "/#/el-date-picker-datetimerange",
  tier: "medium",
  async run(ctx) {
    let fillOk = false;
    let fillText = "";
    try {
      // 注意：vortex datetimerange driver 目前要求 target 精确匹配 .el-date-editor.el-range-editor，
      // 不会自动 closest() 到外层 wrapper。这是 vortex 的可优化点（见 README）。
      const res = await ctx.call("vortex_fill", {
        target: "[data-testid=\"target-datetimerange\"] .el-date-editor.el-range-editor",
        widget: "datetimerange",
        value: { start: START, end: END }
      });
      fillText = extractText(res);
      fillOk = !fillText.toLowerCase().includes("error") && !fillText.includes("INVALID_PARAMS");
    } catch (err) {
      fillText = err instanceof Error ? err.message : String(err);
      fillOk = false;
    }

    ctx.assert(fillOk, `vortex_fill kind=datetimerange 失败: ${fillText.slice(0, 300)}`);

    await assertResultContains(ctx, `start=${START}`);
    await assertResultContains(ctx, `end=${END}`);
  },
};

export default def;
