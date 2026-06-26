// 模态作用域(Modal Scoping,N002 T2-2):aria-modal=true 弹层打开时,observe 默认应裁剪背景并
// 发 # modal: meta;filter=all 背景带 [behind-modal];role=dialog 无 aria-modal 走前置(零漂移)。
//
// 复现:Element Plus dialog 实测,模态 3 按钮混进 56 个背景元素。修复后:
//   ① 默认 observe(filter=interactive)→ 只返回模态内 2 按钮,顶部 # modal: dialog "Tips" (...)
//   ② filter=all → 返全集,12 个 nav 链接 + 伪模态 2 按钮 + listbox 2 选项带 [behind-modal]
//   ③ 负样本:role=dialog 无 aria-modal 的伪模态不走裁剪(走 overlay-priority 前置,零漂移)
//
// 修复点:packages/extension/src/handlers/observe.ts (inject func 内联 + isModalOverlayRoot /
// selectActiveModal / scopeCandidatesToModal 导出);聚合透传 frame.modal;
// packages/mcp/src/lib/observe-render.ts 渲染 # modal: 行 + 行内 [behind-modal] tag。
// 测试:packages/extension/tests/observe-modal-scope.test.ts + mcp/observe-render-modal.test.ts。

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "modal-scope-suppress-background",
  playgroundPath: "/synth/modal-scope-suppress-background.html",
  tier: "hard",
  async run(ctx) {
    // ① 默认 observe(filter=interactive):模态开 → 只见模态 + # modal: meta
    const snapDefault = extractText(await ctx.call("vortex_observe", {}));
    ctx.assert(
      /# modal: dialog "Tips"/.test(snapDefault),
      `aria-modal=true 应触发 # modal: 行。snapshot head:\n${snapDefault.slice(0, 800)}`,
    );
    ctx.assert(
      /\(suppressed \d+ background elements\)/.test(snapDefault),
      `# modal: 行须含 suppressed N background elements。snapshot head:\n${snapDefault.slice(0, 800)}`,
    );
    // 模态内 Confirm/Cancel 应被召回
    ctx.assert(
      /Confirm/.test(snapDefault) && /Cancel/.test(snapDefault),
      `默认 observe 应召回模态内 Confirm/Cancel。snapshot head:\n${snapDefault.slice(0, 800)}`,
    );
    // 12 个背景 nav 链接应被抑制(默认模式)
    ctx.assert(
      !/nav link 1\b/.test(snapDefault),
      `默认 observe 应抑制背景 nav link 1(裁剪生效)。snapshot head:\n${snapDefault.slice(0, 800)}`,
    );

    // ② filter=all:不裁剪但背景带 [behind-modal],模态外可见
    const snapAll = extractText(await ctx.call("vortex_observe", { filter: "all" }));
    ctx.assert(
      /nav link 1/.test(snapAll),
      `filter=all 应返回背景 nav link 1(不裁剪)。snapshot head:\n${snapAll.slice(0, 800)}`,
    );
    ctx.assert(
      /nav link 1[^\n]*\[behind-modal\]/.test(snapAll),
      `filter=all 背景元素应打 [behind-modal] tag。snapshot head:\n${snapAll.slice(0, 800)}`,
    );
    // 模态内按钮不应打 [behind-modal]
    const confirmLine = snapAll.split("\n").find((l) => l.includes('"Confirm"')) ?? "";
    ctx.assert(
      !confirmLine.includes("[behind-modal]"),
      `模态内 Confirm 不应打 [behind-modal]。行: ${confirmLine.trim()}`,
    );

    // ③ 负样本:role=dialog 无 aria-modal(伪模态)走 overlay-priority 前置,不裁剪,行为不变
    ctx.assert(
      /"OK"/.test(snapAll) && /"Apply"/.test(snapAll),
      `伪模态 OK/Apply 应被召回(走前置)。snapshot head:\n${snapAll.slice(0, 800)}`,
    );
    // 伪模态不应被裁剪,默认 observe 应仍能看到(走 overlay-priority 前置)
    ctx.assert(
      /"OK"/.test(snapDefault) || /"Apply"/.test(snapDefault),
      `默认 observe 也应见伪模态按钮(零漂移:不裁剪伪模态)。snapshot head:\n${snapDefault.slice(0, 800)}`,
    );
  },
};

export default def;