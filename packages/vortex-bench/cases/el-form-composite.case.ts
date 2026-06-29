// el-form 组合：input + select + switch + checkbox-group + submit。
// 验证复合表单能否按顺序填完并提交成功。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-form-composite",
  playgroundPath: "/#/el-form-composite",
  tier: "medium",
  async run(ctx) {
    // 1. name 输入
    //   注意：vortex_fill plain 对 Vue el-input 不 dispatch 'input' 事件 → v-model 不响应。
    //   用 vortex_type 逐字符键入来触发真实 input event（速度慢但有效）。
    await ctx.call("vortex_act", {
      action: "type",
      target: "[data-testid=\"form-name\"] input",
      text: "test-name"
    });

    // 2. level 选 "高"（走 el-select，driver 按 label 匹配故传中文 label）
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"form-level\"]",
      widget: "select",
      value: "高"
    });

    // 3. switch 开启：点 .el-switch__core（真正的交互点）
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"form-enabled\"] .el-switch__core"
    });

    // 4. checkbox-group 选 alpha + beta
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"form-tags\"]",
      widget: "checkbox-group",
      value: ["alpha", "beta"]
    });

    // 5. submit
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"form-submit\"] button"
    });

    // 断言提交后 result 包含所有字段
    await assertResultContains(ctx, "test-name");
    await assertResultContains(ctx, "high");
    await assertResultContains(ctx, "alpha");
    await assertResultContains(ctx, "beta");
    // get_text 返回 JSON-escaped 文本（`"` → `\"`），匹配子串即可
    await assertResultContains(ctx, "enabled\\\":true");
  },
};

export default def;
