// 缺口 G — 多标签页。镜像 Stagehand tab_handling/multi_tab:
// 开新 tab → 跨 tab(by tabId)extract 其内容 → 关 tab。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "g-multi-tab",
  playgroundPath: "/synth/a-nav-target.html",
  tier: "medium",
  async run(ctx) {
    const createRes = await ctx.call("vortex_tab_create", {
      url: ctx.playgroundUrl + "/synth/a-nav-target.html",
      active: true,
    });
    const { id: tabId } = JSON.parse(extractText(createRes)) as { id: number };
    ctx.assert(typeof tabId === "number", `tab_create 应返回 tabId,实际: ${extractText(createRes)}`);
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 3000, tabId });
    // 跨 tab extract(by tabId)
    const text = extractText(
      await ctx.call("vortex_extract", { target: '[data-testid="page"]', include: ["text"], tabId }),
    );
    ctx.assert(text.includes("NAV-OK"), `跨 tab extract 应得目标页内容,实际: ${text}`);
    await ctx.call("vortex_tab_close", { tabId });
  },
};
export default def;
