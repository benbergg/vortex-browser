// dialog 应答 — JS dialog(alert/confirm/prompt)应答策略端到端验证。
// 覆盖:dismiss→false / accept→true / 缺省自动 dismiss 警告 / alert 无冻结 /
//        prompt+promptText / async 1000ms grace 窗口。
import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

interface DialogHandled {
  type: string;
  message: string;
  policy: "accepted" | "dismissed";
  warning?: string;
}

/** vortex_act 返回的顶层 JSON 对象。 */
function parseAct(res: unknown): { success?: boolean; dialogHandled?: DialogHandled } {
  return JSON.parse(extractText(res)) as { success?: boolean; dialogHandled?: DialogHandled };
}

const def: CaseDefinition = {
  name: "dialog-handling",
  playgroundPath: "/synth/dialog-handling.html",
  tier: "medium",
  async run(ctx) {
    // ── 1. confirm + onDialog:dismiss → window.__r===false; policy=dismissed; 无 warning ──
    const r1 = parseAct(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#confirm-btn",
        options: { onDialog: "dismiss" },
      }),
    );
    ctx.assert(
      r1.success !== false,
      `#1 dismiss: act 应成功,实际 ${JSON.stringify(r1).slice(0, 200)}`,
    );
    ctx.assert(
      r1.dialogHandled != null,
      `#1 dismiss: 应有 dialogHandled,实际 ${JSON.stringify(r1).slice(0, 200)}`,
    );
    ctx.assert(
      r1.dialogHandled!.type === "confirm",
      `#1 dismiss: dialogHandled.type 应为 confirm,实际 ${r1.dialogHandled!.type}`,
    );
    ctx.assert(
      r1.dialogHandled!.policy === "dismissed",
      `#1 dismiss: policy 应为 dismissed,实际 ${r1.dialogHandled!.policy}`,
    );
    ctx.assert(
      r1.dialogHandled!.warning == null,
      `#1 dismiss(显式): 不应有 warning,实际 ${r1.dialogHandled!.warning}`,
    );
    // 读 window.__r 验证页面侧返回值 false
    const v1 = extractEvalJson<boolean>(
      await ctx.call("vortex_evaluate", { code: "return window.__r;" }),
    );
    ctx.assert(v1 === false, `#1 dismiss: window.__r 应为 false,实际 ${v1}`);

    // ── 2. confirm + onDialog:accept → window.__r===true; policy=accepted; 无 warning ──
    const r2 = parseAct(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#confirm-btn",
        options: { onDialog: "accept" },
      }),
    );
    ctx.assert(
      r2.dialogHandled?.policy === "accepted",
      `#2 accept: policy 应为 accepted,实际 ${r2.dialogHandled?.policy}`,
    );
    ctx.assert(
      r2.dialogHandled?.warning == null,
      `#2 accept: 不应有 warning,实际 ${r2.dialogHandled?.warning}`,
    );
    const v2 = extractEvalJson<boolean>(
      await ctx.call("vortex_evaluate", { code: "return window.__r;" }),
    );
    ctx.assert(v2 === true, `#2 accept: window.__r 应为 true,实际 ${v2}`);

    // ── 3. confirm + 无 onDialog → 默认 dismiss(false); dialogHandled.warning 存在 ──
    const r3 = parseAct(
      await ctx.call("vortex_act", { action: "click", target: "#confirm-btn" }),
    );
    ctx.assert(
      r3.dialogHandled != null,
      `#3 缺省: 应有 dialogHandled,实际 ${JSON.stringify(r3).slice(0, 200)}`,
    );
    ctx.assert(
      r3.dialogHandled!.policy === "dismissed",
      `#3 缺省: policy 应为 dismissed,实际 ${r3.dialogHandled!.policy}`,
    );
    ctx.assert(
      r3.dialogHandled!.warning != null && r3.dialogHandled!.warning.length > 0,
      `#3 缺省: 应携带 warning,实际 ${r3.dialogHandled!.warning}`,
    );
    const v3 = extractEvalJson<boolean>(
      await ctx.call("vortex_evaluate", { code: "return window.__r;" }),
    );
    ctx.assert(v3 === false, `#3 缺省: window.__r 应为 false,实际 ${v3}`);

    // ── 4. alert → act 成功; dialogHandled.type===alert ──
    const r4 = parseAct(
      await ctx.call("vortex_act", { action: "click", target: "#alert-btn" }),
    );
    ctx.assert(
      r4.success !== false,
      `#4 alert: act 应成功,实际 ${JSON.stringify(r4).slice(0, 200)}`,
    );
    ctx.assert(
      r4.dialogHandled?.type === "alert",
      `#4 alert: dialogHandled.type 应为 alert,实际 ${r4.dialogHandled?.type}`,
    );

    // ── 5. prompt + accept + promptText:"X" → window.__p==="X" ──
    const r5 = parseAct(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#prompt-btn",
        options: { onDialog: "accept", promptText: "X" },
      }),
    );
    ctx.assert(
      r5.dialogHandled?.type === "prompt",
      `#5 prompt: dialogHandled.type 应为 prompt,实际 ${r5.dialogHandled?.type}`,
    );
    ctx.assert(
      r5.dialogHandled?.policy === "accepted",
      `#5 prompt: policy 应为 accepted,实际 ${r5.dialogHandled?.policy}`,
    );
    const v5 = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", { code: "return window.__p;" }),
    );
    ctx.assert(v5 === "X", `#5 prompt: window.__p 应为 "X",实际 ${v5}`);

    // ── 6. async confirm(setTimeout 300ms) → act 成功; grace 窗口应抑制; window.__a===false ──
    const r6 = parseAct(
      await ctx.call("vortex_act", { action: "click", target: "#async-btn" }),
    );
    ctx.assert(
      r6.success !== false,
      `#6 async: act 应成功(不冻结),实际 ${JSON.stringify(r6).slice(0, 200)}`,
    );
    // grace 窗 1000ms 覆盖 300ms 延迟;等 500ms 确保 setTimeout 已触发
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const v6 = extractEvalJson<boolean>(
      await ctx.call("vortex_evaluate", { code: "return window.__a;" }),
    );
    ctx.assert(v6 === false, `#6 async grace: window.__a 应为 false(已抑制),实际 ${v6}`);
  },
};
export default def;
