// spike(cdp-first 阶段2):chrome.debugger attach 的 infobar 是否压缩 viewport
// 导致 bbox 坐标偏移。
//
// 序列:① 未 attach 时记 innerHeight/outerHeight + 锚点按钮 bbox →
// ② useRealMouse click 触发 attach → ③ 重测高度/bbox 对比 →
// ④ 合成 click + CDP click 各一次,验证两路坐标仍命中同一元素(aria-pressed
//   翻转计数核对)。
//
// 已知 Chrome 行为候选:infobar 占窗口 chrome 区 → outerHeight 不变、
// innerHeight 縮小、页面元素 viewport 坐标整体上移 → CDP 点击用
// getBoundingClientRect 实时坐标本应自洽,真正的风险是「attach 与点击之间」
// 页面 reflow 的瞬间竞态 + 截图/bbox 缓存类消费方。本 case 记录偏移量数据。

import type { CaseDefinition } from "../src/types.js";
import { extractEvalJson, extractText } from "./_helpers.js";

interface Geom {
  innerHeight: number;
  outerHeight: number;
  innerWidth: number;
  btnTop: number;
  btnLeft: number;
  pressed: string | null;
}

const GEOM_CODE = `(() => {
  const btn = document.querySelector('#toggle-btn');
  const r = btn.getBoundingClientRect();
  return {
    innerHeight: window.innerHeight,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    btnTop: r.top,
    btnLeft: r.left,
    pressed: btn.getAttribute('aria-pressed'),
  };
})()`;

const def: CaseDefinition = {
  name: "spike-infobar-viewport",
  playgroundPath: "/toggle-aria-pressed.html",
  async run(ctx) {
    // ① 未 attach 基线(本 case 此前无 CDP 动作;evaluate 走 executeScript 不 attach)
    const before = extractEvalJson<Geom>(await ctx.call("vortex_evaluate", { code: GEOM_CODE }));
    ctx.assert(before != null, "未拿到 attach 前几何基线");

    // ② 触发 attach(useRealMouse click,顺带翻转 aria-pressed → "true")
    await ctx.call("vortex_act", { action: "click", target: "#toggle-btn", useRealMouse: true });

    // ③ attach 后重测
    const after = extractEvalJson<Geom>(await ctx.call("vortex_evaluate", { code: GEOM_CODE }));
    ctx.assert(after != null, "未拿到 attach 后几何数据");
    ctx.assert(after!.pressed === "true", `CDP click 应翻转 aria-pressed,实际 ${after!.pressed}`);

    ctx.recordMetric("innerHeightBefore", before!.innerHeight);
    ctx.recordMetric("innerHeightAfter", after!.innerHeight);
    ctx.recordMetric("innerHeightDelta", before!.innerHeight - after!.innerHeight);
    ctx.recordMetric("btnTopDelta", Math.round((before!.btnTop - after!.btnTop) * 100) / 100);
    ctx.recordMetric("btnLeftDelta", Math.round((before!.btnLeft - after!.btnLeft) * 100) / 100);

    // ④ attach 常驻状态下两路 click 各一次,验证坐标/路径都仍命中同一元素
    // (forceSynthetic:trusted Chrome 上还原真合成路径)
    await ctx.call("vortex_act", { action: "click", target: "#toggle-btn", forceSynthetic: true }); // 合成 → "false"
    const synth = extractEvalJson<Geom>(await ctx.call("vortex_evaluate", { code: GEOM_CODE }));
    ctx.assert(synth!.pressed === "false", `attach 后合成 click 应翻转回 false,实际 ${synth!.pressed}`);

    const res = await ctx.call("vortex_act", {
      action: "click",
      target: "#toggle-btn",
      useRealMouse: true,
    }); // CDP → "true"
    const final = extractEvalJson<Geom>(await ctx.call("vortex_evaluate", { code: GEOM_CODE }));
    ctx.assert(final!.pressed === "true", `attach 后 CDP click 应翻转为 true,实际 ${final!.pressed}`);
    // CDP click 命中坐标与按钮 bbox 一致性由 cdpClickElement 自身探测保证,
    // 这里额外确认无 ELEMENT_OCCLUDED 之类错误码
    const text = extractText(res);
    ctx.assert(!text.includes("ELEMENT_OCCLUDED"), "attach 后 CDP click 误报遮挡");
  },
};

export default def;
