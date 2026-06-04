// 3 层嵌套 iframe + deep 层有 interactive content —— 验证 vortex page-side
// scanner 能进 nested same-origin iframe 并收元素（B-11 (b) 假设排查）。
//
// fixture：playground/public/iframe-nested-{top,mid,deep}.html
//   /iframe-nested-top.html
//     └── iframe → /iframe-nested-mid.html
//           └── iframe → /iframe-nested-deep.html（深层 button/input/checkbox）
//
// 期望：observe(frames='all') 输出含 @fNeM 形态 ref 指向
// "深层按钮"/"深层输入框"/"深层勾选"。

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "iframe-nested-with-content",
  playgroundPath: "/iframe-nested-top.html",
  tier: "hard",
  async run(ctx) {
    // 3 层 iframe 静态 HTML 应该 < 1s 全 ready，给 1s buffer 即可
    await new Promise((r) => setTimeout(r, 1000));

    const snap = extractText(await ctx.call("vortex_observe", { frames: "all" }));
    ctx.recordMetric("observeAllLen", snap.length);
    // v0.8 hashed ref support: matches @fNeM and @<hash>:fNeM
    const subFrameRefs = (snap.match(/@(?:[a-f0-9]{4}:)?f\d+e\d+/g) ?? []);
    ctx.recordMetric("subFrameRefCount", subFrameRefs.length);

    ctx.assert(snap.includes("深层按钮"),
      `observe 应含 "深层按钮"；snap (${snap.length}B): ${snap}`);
    ctx.assert(snap.includes("深层输入框"),
      `observe 应含 "深层输入框"；snap: ${snap.slice(0, 800)}`);
    ctx.assert(snap.includes("深层勾选"),
      `observe 应含 "深层勾选"；snap: ${snap.slice(0, 800)}`);

    // 应至少有 3 个 sub-frame ref（mid + deep widgets）
    ctx.assert(
      subFrameRefs.length >= 3,
      `应至少 3 个 sub-frame ref，实际 ${subFrameRefs.length}：${snap.slice(0, 600)}`,
    );

    // 注意：mid frame 只是个 iframe wrapper，本身 0 interactive 元素是正常的，
    // 0-elements hint 出现是 renderer feature (Phase 5 fix)，不是 bug。
    // 只断言 deep frame 元素被收 + sub-frame ref 出现即够。
  },
};

export default def;
