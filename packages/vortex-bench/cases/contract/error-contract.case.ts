// 失败路径 · 错误信封（suite B 5/7）：工具错误必须是**可判读的信封**。
//
// 契约：MCP 层的错误文本统一是 `Error [CODE]: <message>` + `Hint: <下一步>`。
// CODE 是大写下划线的稳定标识，message 说清发生了什么，hint 说清下一步该干什么。
// 反例（要防的 regression）：错误退化成一句英文散文或一个裸异常名 —— agent 无法分支处理。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, findRef } from "../_helpers.js";

const def: CaseDefinition = {
  name: "contract/error-contract",
  suite: "b",
  async run(ctx) {
    const obs = await ctx.call("vortex_observe", {});
    const ref = findRef(extractText(obs), "Toggle");
    ctx.assert(ref !== null, "observe 应给出按钮 Toggle 的 ref");
    const hash = (ref as string).slice(1, 5);

    // 触发一个确定的失败：当前快照里不存在的 index
    const res = await ctx.call("vortex_act", {
      action: "click",
      target: `@${hash}:e9999`,
      options: { timeout: 2000 },
    });
    const text = extractText(res);

    // ① 信封形状：`Error [CODE]:` 开头
    ctx.assert(
      /^Error \[[A-Z_]+\]:/m.test(text),
      `错误文本应以 "Error [CODE]:" 开头，实际: ${text.slice(0, 300)}`,
    );
    // ② 这个场景的错误码是确定的（任意码都不算数）
    ctx.assert(
      /Error \[INVALID_INDEX\]/.test(text),
      `坏 index 应报 INVALID_INDEX，实际: ${text.slice(0, 300)}`,
    );
    // ③ hint 段必须在
    ctx.assert(/^Hint:/m.test(text), `错误文本应带 "Hint:" 段，实际: ${text.slice(0, 300)}`);
    // ④ hint 要有实质内容（不是空壳）
    const hint = text.split(/^Hint:/m)[1] ?? "";
    ctx.assert(
      hint.trim().length >= 20,
      `hint 应有实质指引（≥20 字符），实际: "${hint.trim().slice(0, 120)}"`,
    );
  },
};
export default def;
