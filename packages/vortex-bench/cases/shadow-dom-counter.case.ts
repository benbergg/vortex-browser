// Fixture-based: playground/public/shadow-dom-counter.html uses a custom
// element with `attachShadow({ mode: 'open' })`.
//
// Tier 2（Kaizen 穿 shadow）验证合约（已于 2026-05 实现）：
//   此 case 现在对 open-shadow 元素直接走 vortex_act / vortex_extract
//   的完整契约，不再使用 vortex_evaluate 绕过 shadow 边界。
//
//   具体保证：
//   1. vortex_observe 透过 querySelectorAllDeep walker 把 shadow-internal
//      的 button 暴露为 ref（@eN / @<hash>:eN 形式）。
//   2. vortex_act(action=click, target=btnRef) 直接点击 shadow-internal
//      button —— Tier 2 在 dom-resolve 模块中注入 queryAllDeep，
//      dom.click handler 通过 [data-vortex-rid] stamped selector 定位
//      shadow 内元素，无需 vortex_evaluate 兜底。
//   3. vortex_extract(target="#count") 直接读取 shadow-internal 计数
//      文本 —— content.getText handler 同样通过 queryAllDeep 穿透
//      shadow 边界，light-DOM querySelector 找不到则回落到
//      shadowRoot 递归（dom-resolve.ts light-DOM 优先策略）。
//   4. 点击效果经 light-DOM mirror span 二次验证（"外部读数：1"）。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

function findRef(snapshot: string, name: string): string | null {
  // v0.8 hashed ref support: matches @eN / @fNeM / @<hash>:eN / @<hash>:fNeM
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "shadow-dom-counter",
  playgroundPath: "/shadow-dom-counter.html",
  async run(ctx) {
    // custom element 同步注册，runner harness wait_for(idle, dom) 触发时
    // shadow 内元素已在 snapshot 中，无需额外 warm-up。
    const snap = extractText(await ctx.call("vortex_observe", {}));

    // shadow-internal button accessible name 为 "Increment"。
    // 若 vortex 无法穿透 open shadow root，此处快速失败。
    const btnRef = findRef(snap, "Increment");
    ctx.assert(
      btnRef !== null,
      `observe should surface in-shadow button "Increment". snapshot head:\n${snap.slice(0, 600)}`,
    );

    // Tier 2 验证：直接用 vortex_act 点击 shadow-internal button ref。
    // Tier 2 之前此处使用 vortex_evaluate 兜底，因为 dom.click 的
    // selector 解析不穿 shadow 边界（ELEMENT_NOT_FOUND）。
    // 现在 dom-resolve 模块注入后 [data-vortex-rid] 通过 queryAllDeep
    // 在 shadow root 内命中，直接 dispatch。
    // call shape 来自 el-tabs.case.ts / el-tree.case.ts。
    await ctx.call("vortex_act", {
      action: "click",
      target: btnRef,
    });

    // shadow handler 把计数镜像到 light-DOM [data-testid="result"] span，
    // assertResultContains 轮询标准 helper 验证点击生效。
    await assertResultContains(ctx, "外部读数：1");

    // Tier 2 extract 验证：vortex_extract 直接读取 shadow-internal #count span 文本。
    // "#count" 仅存在于 shadow root 内，light-DOM querySelector 找不到，
    // content.getText handler 经 queryAllDeep 穿 shadow 命中并返回 "1"。
    // call shape 来自 jd-review-rm-01-open.case.ts（CSS selector 形式）。
    const innerCountText = extractText(
      await ctx.call("vortex_extract", {
        target: "#count",
        include: ["text"],
      }),
    );
    ctx.assert(
      innerCountText.includes("1"),
      `vortex_extract should read shadow-internal #count as "1" after click. got: ${innerCountText.slice(0, 200)}`,
    );
  },
};

export default def;
