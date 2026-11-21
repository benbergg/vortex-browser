// D-HIST-1（2026-11-21）：vortex_history 退到浏览器内部页历史项时的**错误契约**。
//
// 缺陷现象（改前）：退到该 tab 的第一条历史项（vortex_tab_create 建的新标签页 = 浏览器内部页）时，
// CDP Page.navigateToHistoryEntry 被浏览器拒绝（{"code":-32000,"message":"Not allowed"}），
// 裸错误冒泡 ⇒ 扩展 router 分类为 JS_EXECUTION_ERROR + 通用 hint（让人重试/换方法）。
// 同一函数的栈顶 forward 越界分支早已是 NO_EFFECT + 可执行 hint ⇒ 同类结局两种处理。
//
// 本 case 锁的是**新拒绝分支**（不是只断言 NO_EFFECT —— 原有索引越界分支也返回 NO_EFFECT，
// 只断言错误码会假绿）：
//   ① 错误码是 NO_EFFECT，且**不是** JS_EXECUTION_ERROR；
//   ② 文案说「浏览器拒绝恢复该历史项」（refused to restore），**不是**「已在最新/最旧条目」；
//   ③ hint 指向可执行替代（vortex_navigate）；
//   ④ 拒绝后页面位置未变（独立读 URL 真值，不拿之前成功调用的返回值顶替）。
//
// 为什么需要「back → forward → forward(边界) → back → back」这一串来回：
// 直接 back → back 时 Chrome 的历史表里还没有初始新标签页那条记录，第二次 back 只会落到
// 「已在最旧条目」的索引越界分支 ⇒ 测不到拒绝分支（假绿）。
//
// ⚠️ 该分支的判定在**扩展侧**（packages/extension/src/handlers/page.ts 的 navigateHistory），
// 而 bench 跑的是浏览器里**已安装**的扩展产物：扩展产物落后于源码时本 case 会红，
// 那时红的是「扩展没更新」而不是「代码有缺陷」——失败原因里会明确写出这一点。
//
// 依赖：suite B 自包含 fixture（两个本地 URL，不用外网）。

import type { CaseDefinition } from "../../src/types.js";
import { extractText } from "../_helpers.js";

/** 从 vortex_tab_create 的返回文本里取 tabId（仓内返回字段是 `id`，部分版本是 `tabId`）。 */
function parseTabId(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { tabId?: unknown; id?: unknown };
    for (const raw of [parsed.tabId, parsed.id]) {
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
    }
    return null;
  } catch {
    return null;
  }
}

/** 从 vortex_evaluate 的返回文本里取 location.href。 */
function parseUrl(text: string): string | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : null;
  } catch {
    return null;
  }
}

const def: CaseDefinition = {
  name: "contract/history-back-refused",
  suite: "b",
  async run(ctx) {
    const A = `${ctx.baseUrl}/`;
    const B = `${ctx.baseUrl}/hash-router`;

    const created = extractText(await ctx.call("vortex_tab_create", { active: false }));
    const tabId = parseTabId(created);
    ctx.assert(
      tabId != null,
      `建隔离 tab 失败（拿不到 tabId），实际: ${created.slice(0, 200)}`,
    );

    try {
      const navA = extractText(await ctx.call("vortex_navigate", { url: A, tabId }));
      const navB = extractText(await ctx.call("vortex_navigate", { url: B, tabId }));
      ctx.assert(
        !/Error \[/.test(navA) && !/Error \[/.test(navB),
        `两个本地 URL 都应导航成功，实际: A=${navA.slice(0, 160)} B=${navB.slice(0, 160)}`,
      );

      // 造出「历史表里含初始新标签页条目」的状态：back → forward → forward(边界) → back
      const back1 = extractText(await ctx.call("vortex_history", { tabId, direction: "back" }));
      ctx.assert(!/Error \[/.test(back1), `第一次 back 应成功，实际: ${back1.slice(0, 160)}`);
      const fwd1 = extractText(await ctx.call("vortex_history", { tabId, direction: "forward" }));
      ctx.assert(!/Error \[/.test(fwd1), `forward 应成功，实际: ${fwd1.slice(0, 160)}`);
      const edge = extractText(await ctx.call("vortex_history", { tabId, direction: "forward" }));
      ctx.assert(
        /Error \[NO_EFFECT\]/.test(edge) && /newest entry/i.test(edge),
        `栈顶 forward 应是索引越界 NO_EFFECT（对照组），实际: ${edge.slice(0, 200)}`,
      );
      const back2 = extractText(await ctx.call("vortex_history", { tabId, direction: "back" }));
      ctx.assert(!/Error \[/.test(back2), `再 back 应成功，实际: ${back2.slice(0, 160)}`);

      // —— 到这里：下一次 back 会退到初始新标签页（浏览器内部页）⇒ 触发拒绝分支 ——
      const refusal = extractText(await ctx.call("vortex_history", { tabId, direction: "back" }));

      ctx.assert(
        /Error \[NO_EFFECT\]/.test(refusal),
        `退到内部页应是结构化 NO_EFFECT（若报 JS_EXECUTION_ERROR 多半是扩展产物落后于源码：` +
          `该分支的判定在扩展侧）——实际: ${refusal.slice(0, 220)}`,
      );
      ctx.assert(
        !/JS_EXECUTION_ERROR/.test(refusal),
        `不应再把裸 CDP 错误分类成 JS_EXECUTION_ERROR，实际: ${refusal.slice(0, 220)}`,
      );
      ctx.assert(
        /refused to restore/i.test(refusal),
        `文案应陈述「浏览器拒绝恢复该历史项」（refused to restore），实际: ${refusal.slice(0, 220)}`,
      );
      ctx.assert(
        !/already at the (newest|oldest) entry/i.test(refusal),
        `拒绝分支不应复用索引越界文案（否则与对照组不可区分），实际: ${refusal.slice(0, 220)}`,
      );
      ctx.assert(
        /Hint:/.test(refusal) && /vortex_navigate/.test(refusal),
        `hint 应指向可执行替代（vortex_navigate），实际: ${refusal.slice(0, 260)}`,
      );

      // 拒绝后**独立**读当前 URL（不拿之前成功调用的返回值顶替）
      const truth = extractText(
        await ctx.call("vortex_evaluate", {
          tabId,
          code: "(() => ({ url: location.href }))()",
        }),
      );
      const afterUrl = parseUrl(truth);
      ctx.assert(
        afterUrl === A,
        `拒绝后页面位置应未变（仍在 ${A}），实际: ${afterUrl ?? truth.slice(0, 160)}`,
      );
    } finally {
      if (tabId != null) {
        await ctx.call("vortex_tab_close", { tabId });
      }
    }
  },
};

export default def;
