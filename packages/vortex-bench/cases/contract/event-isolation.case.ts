// 失败路径 · 事件隔离（suite B 4/7）：后台 tab 的慢请求不得污染前台 tab 的 idle 判定。
//
// 契约：idle/network 判定是**按 tab** 的。后台 tab 挂着一个 6s 才回的请求时，
// 前台 tab 的 vortex_wait_for(idle=network) 必须照常立刻判定空闲。
// 反例（要防的 regression）：idle 判定看的是全局请求表 → 前台被后台的慢请求拖住，
// 直到超时，agent 在正常页面上也会卡住。
import type { CaseDefinition } from "../../src/types.js";
import { extractText } from "../_helpers.js";

const SLOW_MS = 6000;

interface TabInfo {
  id: number;
  url?: string;
  status?: string;
  current?: boolean;
}

/** vortex_tab_list 的返回可能是数组，也可能是 { tabs, otherBrowsers } —— 两种都吃。 */
function parseTabs(res: unknown): TabInfo[] {
  const raw = extractText(res);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { tabs?: unknown }).tabs;
  return Array.isArray(arr) ? (arr as TabInfo[]) : [];
}

const def: CaseDefinition = {
  name: "contract/event-isolation",
  suite: "b",
  async run(ctx) {
    // 前台 tab = runner 已导航到 fixture 首页的那个
    const tabs = parseTabs(await ctx.call("vortex_tab_list", {}));
    const fg =
      tabs.find((t) => t.current === true && (t.url ?? "").startsWith(ctx.baseUrl)) ??
      tabs.find((t) => (t.url ?? "").startsWith(ctx.baseUrl) && t.status === "complete");
    ctx.assert(
      fg !== undefined,
      `tab_list 应能认出前台 fixture tab（baseUrl=${ctx.baseUrl}），实际: ${JSON.stringify(tabs).slice(0, 300)}`,
    );

    // 后台 tab：挂一个 6s 才回的慢请求
    const created = await ctx.call("vortex_tab_create", {
      url: `${ctx.baseUrl}/slow?ms=${SLOW_MS}`,
      active: false,
    });
    const { id: bgTabId } = JSON.parse(extractText(created)) as { id: number };
    ctx.assert(typeof bgTabId === "number", `tab_create 应返回 tabId，实际: ${extractText(created).slice(0, 200)}`);

    try {
      // 给后台 tab 一点时间把请求发出去
      await new Promise((r) => setTimeout(r, 600));
      const bg = parseTabs(await ctx.call("vortex_tab_list", {})).find((t) => t.id === bgTabId);
      ctx.assert(
        bg?.status === "loading",
        `后台 tab 应处于 loading（慢请求在飞），实际 status=${bg?.status}`,
      );

      // 前台 tab 的 idle 判定：必须立刻空闲，不被后台慢请求拖住
      const t0 = Date.now();
      const idle = await ctx.call("vortex_wait_for", {
        mode: "idle",
        value: "network",
        timeout: 4000,
        tabId: (fg as TabInfo).id,
      });
      const elapsed = Date.now() - t0;
      const idleText = extractText(idle);
      ctx.assert(
        !/Error \[/.test(idleText),
        `前台 idle 判定不应报错（被后台慢请求拖到超时），实际: ${idleText.slice(0, 200)}`,
      );
      ctx.assert(
        elapsed < SLOW_MS,
        `前台 idle 判定不应被后台的 ${SLOW_MS}ms 慢请求拖住，实际耗时 ${elapsed}ms`,
      );
    } finally {
      await ctx.call("vortex_tab_close", { tabId: bgTabId });
    }
  },
};
export default def;
