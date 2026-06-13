// vortex_press 可打印字符文本插入(2026-06-13 Element Plus dogfood A3)。
//
// 旧实现的 dispatchKey 只发 keyDown/keyUp 不带 CDP `text` 字段 → keydown/keyup
// 事件照发但浏览器不执行默认"插入字符"动作 → press('a') 返回 success 却 input.value
// 不变(silent false success),且与 Playwright keyboard.press 行为 divergence。
// 修复:单个可打印字符 + 无修饰键的 keyDown 补 text/unmodifiedText。
//
// 本 case 锁集成层回归:fixture 的 input 只在真正发生 `input` 事件(=字符被插入)
// 时把 value 反射到结果区。若回归(无 text),结果区保持 (empty),断言失败。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "vortex-press-text-insert",
  playgroundPath: "/press-text-insert.html",
  async run(ctx) {
    // 点击聚焦(确定性优于 autofocus)。
    await ctx.call("vortex_act", { action: "click", target: "#text-target" });

    // 逐字符按可打印键 —— 每次都应触发 input 事件并累加 value。
    await ctx.call("vortex_press", { key: "h" });
    await ctx.call("vortex_press", { key: "i" });

    // input 事件把 value 反射到 [data-testid="result"];"hi" 出现 = 字符真插入。
    await assertResultContains(ctx, "hi");
  },
};

export default def;
