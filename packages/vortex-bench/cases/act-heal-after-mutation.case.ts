// descriptor 透明自愈回归护栏（Task 6）。
//
// 验证序列：
//   1. observe 拿 "Save" 按钮 ref（@<hash>:eN 形态）。
//   2. 用 vortex_evaluate 把 id="b1" 改成 id="b9"，
//      使原 selector #b1 失效，但 role=button + name="Save" descriptor 保留。
//   3. vortex_act({action:"click", target: <同一 ref>}) — 触发自愈重匹配。
//   4. 断言：
//      a. act 成功（非 isError，非 STALE_REF / STALE_SNAPSHOT）。
//      b. 结果文本包含 "healed":true（extension dom.ts 自愈路径写入）。
//      c. 页面 result 元素变为 "clicked"（自愈后真正点到了按钮）。
//
// 注意：
// - ctx.call 对 MCP isError 响应不 throw，bench case 须手动检测 isError 字段。
// - act 成功结果文本是 JSON.stringify(resp.result, null, 2)，
//   自愈时结构为 {..., "healed": true}；断言检查文本含 '"healed": true'。
// - 实跑依赖活 Chrome + 扩展，端到端验证延至 Task 7 live。

import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "act-heal-after-mutation",
  playgroundPath: "/act-heal-after-mutation.html",
  tier: "hard",
  async run(ctx) {
    // 静态 HTML，等待渲染稳定
    await new Promise((r) => setTimeout(r, 200));

    // ── 步骤 1: observe 收集，拿 "Save" 按钮的 ref ──
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const saveRef = findRef(snap, "Save");
    ctx.assert(
      saveRef !== null,
      `observe 应暴露 "Save" 按钮。snapshot:\n${snap.slice(0, 400)}`,
    );

    // ── 步骤 2: 用 evaluate 改 DOM，让原选择器 #b1 失效（改 id 为 b9）──
    // 文本 "Save" 与 role=button 保留，descriptor 仍可重匹配。
    await ctx.call("vortex_evaluate", {
      code: `
        const btn = document.getElementById("b1");
        if (!btn) throw new Error("找不到 #b1，fixture 未加载");
        btn.id = "b9";
        return btn.id;
      `,
    });

    // 验证 DOM 变更已生效（#b1 不再存在，#b9 存在）
    const b1Exists = extractEvalJson<boolean>(
      await ctx.call("vortex_evaluate", {
        code: `return document.getElementById("b1") !== null;`,
      }),
    );
    ctx.assert(
      !b1Exists,
      `DOM 变更应使 #b1 消失，但 querySelector('#b1') 仍返回元素`,
    );

    // ── 步骤 3: 用原 ref 触发 act，期待自愈路径介入 ──
    const actResult = (await ctx.call("vortex_act", {
      target: saveRef as string,
      action: "click",
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    const actText = actResult.content?.[0]?.text ?? "";

    // ── 步骤 4a: act 必须成功（非 isError） ──
    ctx.assert(
      actResult.isError !== true,
      `vortex_act 自愈路径应成功（非 isError），实际结果: ${actText.slice(0, 300)}`,
    );

    // ── 步骤 4b: 结果文本必须包含 healed:true（自愈信号） ──
    // extension dom.ts 在自愈成功时把 healed:true 合并到返回对象，
    // MCP server 以 JSON.stringify 序列化，bench case 在文本层检查。
    ctx.assert(
      actText.includes('"healed": true') || actText.includes('"healed":true'),
      `act 结果应包含 "healed": true（descriptor 自愈信号），实际: ${actText.slice(0, 300)}`,
    );

    // ── 步骤 4c: 页面 result 元素确认真正点到了按钮 ──
    const resultText = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", {
        code: `return document.querySelector('[data-testid="result"]').textContent.trim();`,
      }),
    );
    ctx.assert(
      resultText === "clicked",
      `自愈后按钮应被真正点击，result 应为 "clicked"，实际: "${resultText}"`,
    );

    ctx.recordMetric("healedActSuccess", 1);
  },
};

export default def;
