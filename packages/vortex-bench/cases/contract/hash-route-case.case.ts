// hash 路由的大小写敏感（suite B 8/9）：A12 的行为断言。
//
// 契约：应用路由**按大小写敏感**匹配 —— 同一个路由名，正确大小写命中应用路由
// （页面渲染出该路由的内容），错误大小写**不命中**（页面渲染出"没有这条路由"）。
//
// 要点：**导航 HTTP 成功 ≠ 应用路由存在**。
// 两次导航都是 200、都拿到一个能渲染的页面；差别只在应用路由是否存在。
// 旧写法只断言"导航没报错"，那对大小写完全失明 —— 页面明明是空的/错的，
// 断言照样绿。这条用例改成断言**页面元素**：
//   正确大小写 → 命中标识在 DOM 里；
//   错误大小写 → 同一标识**不在** DOM 里。
//
// fixture 是自包含的（suite B）：/hash-router 页内联一个精确匹配的 hash 路由表，
// 路由表由 packages/vortex-bench/src/fixture.ts 的常量注入（唯一真值）。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, extractEvalJson } from "../_helpers.js";
import {
  HASH_ROUTE_CORRECT,
  HASH_ROUTE_WRONG_CASE,
  HASH_ROUTE_OUT_ID,
} from "../../src/fixture.js";

/** 页面里路由判定结果的回读形状。 */
interface RouteState {
  /** 应用路由是否命中（页面自己的判定，不是我们替它判）。 */
  matched: boolean;
  /** 页面渲染出的标识文本。 */
  text: string | null;
  /** 当前 hash。 */
  hash: string;
}

/** 回读页面当前渲染出的路由状态。 */
async function readRouteState(ctx: {
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<RouteState> {
  return extractEvalJson<RouteState>(
    await ctx.call("vortex_evaluate", {
      code: `(function(){
        var el = document.getElementById(${JSON.stringify(HASH_ROUTE_OUT_ID)});
        if (!el) return { matched: false, text: null, hash: String(window.location.hash || '') };
        return {
          matched: el.getAttribute('data-route') === 'matched',
          text: el.textContent,
          hash: String(window.location.hash || '')
        };
      })()`,
    }),
  );
}

const def: CaseDefinition = {
  name: "contract/hash-route-case",
  suite: "b",
  async run(ctx) {
    // ── ① 正确大小写：导航成功，且应用路由命中 ────────────────────────────
    const navOk = extractText(
      await ctx.call("vortex_navigate", { url: `${ctx.baseUrl}/hash-router${HASH_ROUTE_CORRECT}` }),
    );
    ctx.assert(
      !/Error \[/.test(navOk),
      `正确大小写的导航不应报错，实际: ${navOk.slice(0, 200)}`,
    );
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });

    const hit = await readRouteState(ctx);
    ctx.assert(
      hit.matched === true,
      `正确大小写应命中应用路由（${HASH_ROUTE_CORRECT}），实际 hash=${hit.hash} text=${JSON.stringify(hit.text)}`,
    );
    ctx.assert(
      typeof hit.text === "string" && hit.text.length > 0 && hit.text !== "PENDING",
      `命中时页面应渲染出路由内容，实际 text=${JSON.stringify(hit.text)}`,
    );

    // ── ② 错误大小写：导航**同样成功**，但应用路由不存在 ───────────────────
    const navMiss = extractText(
      await ctx.call("vortex_navigate", { url: `${ctx.baseUrl}/hash-router${HASH_ROUTE_WRONG_CASE}` }),
    );
    ctx.assert(
      !/Error \[/.test(navMiss),
      `错误大小写的导航也不该报错（这正是要点：导航成功 ≠ 路由存在），实际: ${navMiss.slice(0, 200)}`,
    );
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });

    const miss = await readRouteState(ctx);
    ctx.assert(
      miss.matched === false,
      `错误大小写不应命中应用路由（${HASH_ROUTE_WRONG_CASE}），实际 hash=${miss.hash} text=${JSON.stringify(miss.text)}`,
    );
    ctx.assert(
      miss.text !== hit.text,
      `错误大小写时页面内容应与命中时不同（命中: ${JSON.stringify(hit.text)}，未命中: ${JSON.stringify(miss.text)}）`,
    );
  },
};

export default def;
