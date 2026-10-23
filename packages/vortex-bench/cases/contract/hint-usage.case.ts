// 失败路径 · hint 可用性（suite B 7/7）：已知会带 hint 的错误必须真的带 hint，
// 而且 hint 指向的工具必须在**公开工具集**里真实存在 —— 指引一个 tools/list
// 拿不到的工具名就是坏 hint（这正是 PUBLIC_TOOL_NAMES 单一真值表要防的事）。
import type { CaseDefinition } from "../../src/types.js";
import { extractText } from "../_helpers.js";
import { PUBLIC_TOOL_NAMES } from "@vortex-browser/shared";

const def: CaseDefinition = {
  name: "contract/hint-usage",
  suite: "b",
  async run(ctx) {
    // 已知带 hint 的错误：target 用了 Playwright 语法（text=）→ INVALID_SELECTOR
    const res = await ctx.call("vortex_act", { action: "click", target: "text=hello" });
    const text = extractText(res);

    ctx.assert(
      /Error \[INVALID_SELECTOR\]/.test(text),
      `text= 语法应报 INVALID_SELECTOR，实际: ${text.slice(0, 300)}`,
    );
    ctx.assert(/hint/i.test(text), `错误文本应含 hint，实际: ${text.slice(0, 300)}`);

    const hint = text.split(/^Hint:/m)[1] ?? "";
    ctx.assert(
      hint.trim().length >= 20,
      `hint 应有实质内容（≥20 字符），实际: "${hint.trim().slice(0, 120)}"`,
    );

    // hint 指向的工具必须在公开工具集里（不是 tools/list 拿不到的名字）
    const mentioned = [...hint.matchAll(/vortex_[a-z_]+/g)].map((m) => m[0]);
    ctx.assert(
      mentioned.length > 0,
      `hint 应指向具体工具，实际: "${hint.trim().slice(0, 160)}"`,
    );
    const unknown = [...new Set(mentioned.filter((t) => !PUBLIC_TOOL_NAMES.has(t)))];
    ctx.assert(
      unknown.length === 0,
      `hint 指向了公开工具集里没有的工具: ${unknown.join(", ")}`,
    );
  },
};
export default def;
