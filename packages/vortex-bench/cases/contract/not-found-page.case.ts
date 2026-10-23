// 失败路径 · 错误页（suite B 6/7）：404 页必须能被 agent 读懂。
//
// 契约：导航到不存在的路径后，页面本身要带**可断言的错误标识**（状态码 + 标识文本），
// 让 agent 不必猜"是不是页面没加载出来"。工具层**不要求**报错 ——
// HTTP 404 是正常导航结果，页面照样渲染出来。
import type { CaseDefinition } from "../../src/types.js";
import { extractText } from "../_helpers.js";
import { FIXTURE_NOT_FOUND_MARKER } from "../../src/fixture.js";

const def: CaseDefinition = {
  name: "contract/not-found-page",
  suite: "b",
  async run(ctx) {
    const nav = await ctx.call("vortex_navigate", { url: `${ctx.baseUrl}/404` });
    const navText = extractText(nav);
    ctx.assert(
      !/Error \[/.test(navText),
      `404 是正常导航结果，不该报工具错误，实际: ${navText.slice(0, 200)}`,
    );
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });

    const body = extractText(await ctx.call("vortex_extract", {}));
    ctx.assert(body.includes("404"), `404 页应含状态码文本，实际: ${body.slice(0, 200)}`);
    ctx.assert(
      body.includes(FIXTURE_NOT_FOUND_MARKER),
      `404 页应含错误标识 ${FIXTURE_NOT_FOUND_MARKER}，实际: ${body.slice(0, 200)}`,
    );
  },
};
export default def;
