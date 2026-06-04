// 3 层嵌套 iframe + deep 层 0 interactive elements —— 验证 v0.7.0 renderer
// hint："# frame N scanned, 0 interactive elements"。
//
// fixture：playground/public/iframe-nested-{top-empty,mid-empty,deep-empty}.html
//
// 这条 case 复刻 testc 评价分析 dogfood 误诊场景：scanned=true 但 0 元素时
// renderer 应公开提示，而不是沉默。

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "iframe-nested-empty-deep",
  playgroundPath: "/iframe-nested-top-empty.html",
  tier: "hard",
  async run(ctx) {
    await new Promise((r) => setTimeout(r, 1000));

    const snap = extractText(await ctx.call("vortex_observe", { frames: "all" }));
    ctx.recordMetric("observeLen", snap.length);
    const emptyHints = (snap.match(/# frame \d+ scanned, 0 interactive elements/g) ?? []);
    ctx.recordMetric("emptyHintCount", emptyHints.length);

    // 至少一个 sub-frame 应被报告为 "scanned, 0 interactive elements"。
    // 期望：deep-empty 那一层（mid 也可能 0 因为只有 iframe 元素）→ 至少 1 个 hint。
    ctx.assert(
      emptyHints.length >= 1,
      `应至少 1 个 0-elements hint，实际 ${emptyHints.length}；snap: ${snap}`,
    );

    // 不应误报为 "not scanned"（fixture 全 same-origin）
    const notScannedHits = (snap.match(/# frame \d+ not scanned/g) ?? []);
    ctx.assert(
      notScannedHits.length === 0,
      `不应有 not scanned 提示（fixture 全 same-origin）：${notScannedHits.join(", ")}`,
    );
  },
};

export default def;
