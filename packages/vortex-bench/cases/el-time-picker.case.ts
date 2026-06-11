// el-time-picker：用 fill kind=time（CDP 打开 panel + spinner 列 click + 确定）
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const TIME = "14:30:45";

const def: CaseDefinition = {
  name: "el-time-picker",
  playgroundPath: "/#/el-time-picker",
  tier: "medium",
  async run(ctx) {
    // kind=time 走 vortex_fill 的 element-plus-time commit driver(与其他 widget case
    // el-select/daterange 一致)。CDP-first 转正暴露:旧版误用 vortex_act(fill,kind),
    // 但 kind 是 act 死参(只 vortex_fill 有 kind→commit 路由)→ 走 plain fill,转正前靠
    // value-setter 碰巧写 input value 通过,转正后 CDP insertText 触发 spinner widget
    // 落当前时间。act+kind 死参属 dead-param 族,另记 issue。
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"target-time-picker\"] input",
      kind: "time",
      value: TIME
    });
    await assertResultContains(ctx, `time=${TIME}`);
  },
};

export default def;
