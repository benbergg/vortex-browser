// el-slider：借助 show-input 的 input-number 直接 type 目标值。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-slider",
  playgroundPath: "/#/el-slider",
  tier: "medium",
  async run(ctx) {
    // 直接使用 vortex_fill 设置 input-number 的值。
    // target 必须指向内部 <input>：dom.fill 的 actionability 检查只接受
    // input/textarea/select/contenteditable，div 容器（.el-input-number）
    // 会立即抛 NOT_EDITABLE。value 用 string，因 dom.fill 走 nativeInputValueSetter。
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"target-slider\"] .el-input-number input",
      value: "50"
    });

    // el-input-number only emits to v-model on blur/change/Enter — the
    // raw `input` event vortex_fill dispatches isn't enough by itself.
    // Mirror what el-input-number.case.ts does (Tab triggers blur).
    await ctx.call("vortex_press", { key: "Tab" });

    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 500
    });

    await assertResultContains(ctx, "val=50");
  },
};

export default def;
