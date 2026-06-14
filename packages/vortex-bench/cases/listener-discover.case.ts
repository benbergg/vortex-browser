// T3 discovery 承重墙护栏(2026-06-14):pre-scan CDP getEventListeners 把纯
// addEventListener 点击 div 当入池信号 → DISCOVER + 打 [listener]。
// 镜像 browser-use has_js_click_listener 入池信号(dom/service.py:822),但走 vortex
// 唯一可用的 DOMDebugger.getEventListeners(depth:-1,pierce) 路径(CommandLineAPI
// 经 chrome.debugger 不暴露)。四重断言:发现 / 标注 / 可操作 / 无过收。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "listener-discover",
  playgroundPath: "/synth/listener-discover.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { filter: "all" }));

    // ① 发现:裸 div(cursor:default、无 role/框架 prop)仅靠 getEventListeners 被收集
    const ref = findRef(snap, "vanilla 监听器按钮");
    ctx.assert(
      ref !== null,
      `pre-scan getEventListeners 应发现纯 addEventListener 裸 div。snapshot:\n${snap.slice(0, 500)}`,
    );

    // ② 标注:该 div 行须带 [listener] 真值标记
    const vanillaLine = snap.split("\n").find((l) => l.includes("vanilla 监听器按钮")) ?? "";
    ctx.assert(
      vanillaLine.includes("[listener]"),
      `发现的监听器 div 应打 [listener]。行: ${vanillaLine.trim()}`,
    );

    // ③ 无过收:同构但无监听器的对照块不得被收集(证明靠监听器信号而非文本/结构)
    ctx.assert(
      findRef(snap, "无监听器装饰块") === null,
      `无监听器的同构 div 不应被收集(否则是文本/结构误收,非监听器信号)。snapshot:\n${snap.slice(0, 500)}`,
    );

    // ④ 可操作:via-ref 点击触发真 handler
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await assertResultContains(ctx, "vanilla-clicked");
  },
};
export default def;
