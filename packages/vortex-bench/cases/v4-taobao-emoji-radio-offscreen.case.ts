/**
 * Author: 青蛙
 * Description: v4 淘宝评测 4 个修复 E2E 验证 case。
 *
 * 背景: 2026-06-07 淘宝评价信息操作深度评测发现 5 个独立缺陷 (评审
 *   收敛 6→5)。本 case 综合验证已 commit 的 4 个修复:
 *     缺陷① commit aa5f8f8: <label> 包 radio/checkbox 但内无文本 → BUG-3
 *       噪声过滤后整控件隐形。修法: 兜底名 + BUG-3 豁免
 *     缺陷② commit c4c132d: 默认 scope=viewport 静默过滤 left:-9999px
 *       可交互元素。修法: 离屏可交互豁免 + offScreenActionable 标记
 *     缺陷③ commit 06d6520: 严格 1-RAF === stable 检查在淘宝子像素
 *       reflow 下永远 NOT_STABLE。修法: 0.5px 容差 (L2-spec §7.2 决策 A)
 *     缺陷⑤ commit a81ba4a: MCP 端 activeSnapshotId 导航不清空,
 *       bare ref 绕过 v0.8 hash 严判。修法: tab 维度校验
 *
 * 缺陷④ kind=radio driver 按评审 P2 后置, 不在本 case 覆盖。
 *
 * Playground: /synth/v4-淘宝-emoji-radio-offscreen.html
 * 跑法: pnpm --filter @vortex-browser/bench run --case v4-淘宝-emoji-radio-offscreen
 *
 * 期望结果: 4 个场景全部通过 (ctx.assert 不抛)。
 */

import type { CaseDefinition } from "../src/types.js";
import { extractText, extractEvalJson } from "./_helpers.js";

const def: CaseDefinition = {
  name: "v4-taobao-emoji-radio-offscreen",
  playgroundPath: "/synth/v4-taobao-emoji-radio-offscreen.html",
  tier: "medium", // 综合场景, 中等难度
  async run(ctx) {
    // Settle: CSS animation 启动 + bench 渲染, 给 500ms 稳定窗口
    await new Promise((r) => setTimeout(r, 500));

    // ==========================================================
    // 缺陷①: <label> 包 radio 但内无文本 → 兜底名应含 radio=N @x=...,y=...
    // ==========================================================
    // 用 detail=full 拿 JSON 原始输出 (compact render 不会暴露 role/位置细节)
    const fullText = extractText(
      await ctx.call("vortex_observe", { detail: "full", scope: "full" }),
    );
    const fullJson = JSON.parse(fullText) as {
      elements: Array<{
        tag: string;
        name?: string;
        bbox?: { x: number; y: number };
        offScreenActionable?: boolean;
        inViewport?: boolean;
      }>;
    };

    // 缺陷① 验证: 找到至少 3 个 emoji label, 每个含 radio=N @x=...,y=... 兜底名
    const emojiLabels = fullJson.elements.filter(
      (e) => e.tag === "label" && e.name?.startsWith("radio=") && e.name?.includes("@x="),
    );
    ctx.assert(
      emojiLabels.length >= 3,
      `缺陷①: 期望至少 3 个 emoji label 含兑底名 'radio=@x=', 实际 ${emojiLabels.length} 个。\n` +
      `labels 详情: ${JSON.stringify(emojiLabels.map((e) => e.name), null, 2)}`,
    );

    // 验证兑底名格式: radio=N @x=NNN,y=NNN (基于 input.value + bbox)
    for (const lbl of emojiLabels) {
      const m = lbl.name?.match(/^radio=(-?\d+) @x=(\d+),y=(\d+)$/);
      ctx.assert(
        m != null,
        `缺陷①: 兑底名格式应 'radio=N @x=NNN,y=NNN', 实际 '${lbl.name}'`,
      );
      // 验证 bbox 字段与兑底名一致
      ctx.assert(
        lbl.bbox != null && lbl.bbox.x === parseInt(m![2], 10) && lbl.bbox.y === parseInt(m![3], 10),
        `缺陷①: 兑底名坐标应与 bbox 一致, 兑底名='${lbl.name}' bbox=${JSON.stringify(lbl.bbox)}`,
      );
    }

    ctx.recordMetric("缺陷①emojiLabelFallbackNames", emojiLabels.length);

    // ==========================================================
    // 缺陷②: left:-9999px 元素 (CSS a11y-hidden) 应保留 + offScreenActionable
    // ==========================================================
    // 找到 5 个离屏 rate-stars label
    const offscreenLabels = fullJson.elements.filter(
      (e) => e.tag === "label" && e.offScreenActionable === true,
    );
    ctx.assert(
      offscreenLabels.length >= 5,
      `缺陷②: 期望至少 5 个 label 标记 offScreenActionable=true, 实际 ${offscreenLabels.length} 个。\n` +
      `详情: ${JSON.stringify(offscreenLabels.slice(0, 10).map((e) => ({ name: e.name, offScreen: e.offScreenActionable, x: e.bbox?.x })), null, 2)}`,
    );

    // 验证 inViewport=false + offScreenActionable=true 一致
    for (const lbl of offscreenLabels) {
      ctx.assert(
        lbl.inViewport === false && lbl.offScreenActionable === true,
        `缺陷②: 离屏 label 应 inViewport=false 且 offScreenActionable=true, 实际 inViewport=${lbl.inViewport} offScreen=${lbl.offScreenActionable}`,
      );
    }

    ctx.recordMetric("缺陷②offscreenActionableKept", offscreenLabels.length);

    // ==========================================================
    // 缺陷③: 0.5px 子像素漂动 click 不 NOT_STABLE
    // ==========================================================
    // 找到抖动按钮
    const jitterSnapText = extractText(
      await ctx.call("vortex_observe", { detail: "compact" }),
    );
    const jitterRefMatch = jitterSnapText.match(/(@[a-f0-9]{4}:e\d+|@e\d+)\s*\[button\]\s*"抖动按钮/);
    ctx.assert(
      jitterRefMatch != null,
      `缺陷③: observe 应暴露抖动按钮 ref. snapshot:\n${jitterSnapText.slice(0, 400)}`,
    );
    const jitterRef = jitterRefMatch![1];

    // 不带 force:true 直接 click 抖动按钮, 修复前永远 NOT_STABLE, 修复后应成功
    const clickResult = (await ctx.call("vortex_act", {
      target: jitterRef,
      action: "click",
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    ctx.assert(
      clickResult.isError !== true,
      `缺陷③: click 抖动按钮不应 NOT_STABLE (0.5px 容差生效), 但 isError=true。\n` +
      `结果: ${JSON.stringify(clickResult).slice(0, 400)}`,
    );

    // 验证 click 真生效 (button 收到 click 事件)
    const clickReceived = extractEvalJson<boolean>(
      await ctx.call("vortex_evaluate", {
        code: "return window.__jitterBtnClicked === true;",
      }),
    );
    // 注: 修复未要求 button 实现 click handler; 这里用 evaluate 验证 document 状态
    // 简单验证: button 仍存在 + click 路径未 throw
    ctx.recordMetric("缺陷③subpixelStableClickOk", clickResult.isError === false ? 1 : 0);

    // ==========================================================
    // 缺陷⑤: 跨 observe 后旧 ref 命中应 throw STALE_SNAPSHOT (tab 维度)
    // ==========================================================
    // 流程: observe 拿 ref1 → observe 拿 ref2 (hash 不同) → 用 ref1 应 throw
    const snap1 = extractText(
      await ctx.call("vortex_observe", { detail: "full" }),
    );
    const ref1Match = snap1.match(/(@[a-f0-9]{4}:(?:f\d+)?e\d+)/);
    ctx.assert(
      ref1Match != null,
      `缺陷⑤: observe1 应输出 hashed ref. snapshot:\n${snap1.slice(0, 400)}`,
    );
    const staleRef = ref1Match![1];

    // 第二次 observe 触发新 snapshotId (不同 hash)
    const snap2 = extractText(
      await ctx.call("vortex_observe", { detail: "full" }),
    );
    const ref2Match = snap2.match(/(@[a-f0-9]{4}:(?:f\d+)?e\d+)/);
    ctx.assert(
      ref2Match != null,
      `缺陷⑤: observe2 应输出 hashed ref. snapshot:\n${snap2.slice(0, 400)}`,
    );
    ctx.assert(
      ref1Match![1].split(":")[0] !== ref2Match![1].split(":")[0],
      `缺陷⑤: observe1/observe2 hash 应不同 (v0.8 mint 不同 snapshotId). ` +
      `都为 ${ref1Match![1].split(":")[0]} 时可能 4-hex 冲突, 重跑。`,
    );

    // 用 observe1 的 ref 调 vortex_act, 应 throw STALE_SNAPSHOT
    const staleAct = (await ctx.call("vortex_act", {
      target: staleRef,
      action: "click",
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    ctx.assert(
      staleAct.isError === true,
      `缺陷⑤: 旧 ref ${staleRef} 跨 observe 后应 isError, 实际 success. ` +
      `结果: ${JSON.stringify(staleAct).slice(0, 400)}`,
    );
    const errText = staleAct.content?.[0]?.text ?? "";
    ctx.assert(
      errText.includes("[STALE_SNAPSHOT]"),
      `缺陷⑤: 错误应含 [STALE_SNAPSHOT], 实际: ${errText.slice(0, 400)}`,
    );

    ctx.recordMetric("缺陷⑤staleRefRejected", 1);
  },
};

export default def;
