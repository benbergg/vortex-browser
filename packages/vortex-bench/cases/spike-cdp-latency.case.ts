// spike(cdp-first 阶段1):合成 click vs CDP 真鼠标 click 的端到端延迟对比。
// 同一纯按钮(无弹层,aria-pressed 幂等切换)上各采样 N 次,记 P50/P90;
// 第一次 useRealMouse click 即冷 attach(本 case 此前无任何 CDP 动作),单独记录。
// timings 拆分(attachMs/probeMs/dispatchMs)由 cdpClickElement 返回,取末次采样记录。
// 判别锚点(spike 计划):warm 增量 ≤30ms 无感,>100ms 显著。

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const SAMPLES = 100;

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

const def: CaseDefinition = {
  name: "spike-cdp-latency",
  playgroundPath: "/toggle-aria-pressed.html",
  async run(ctx) {
    // selector 直击(#toggle-btn),不走 ref:循环内不掺 observe 开销,两模式同构
    const target = "#toggle-btn";

    // ===== pass 1:合成 click(forceSynthetic 压过 trusted Chrome 的注入,
    // 否则本机 --silent-debugger-extension-api 下两组全是 CDP,对照失效)× N =====
    const synthetic: number[] = [];
    let syntheticWasCdp = 0; // 自检:合成组结果若出现 realMouse = forceSynthetic 失效/被污染
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now();
      const res = await ctx.call("vortex_act", { action: "click", target, forceSynthetic: true });
      synthetic.push(Date.now() - t0);
      if (i === 0 && extractText(res).includes("realMouse")) syntheticWasCdp = 1;
    }
    ctx.recordMetric("syntheticWasCdp", syntheticWasCdp);

    // ===== pass 2:CDP 真鼠标 × N(首次即冷 attach)=====
    const cdp: number[] = [];
    let lastTimings: { attachMs: number; probeMs: number; dispatchMs: number } | null = null;
    let coldAttachMs = -1;
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now();
      const res = await ctx.call("vortex_act", {
        action: "click",
        target,
        useRealMouse: true,
      });
      cdp.push(Date.now() - t0);
      // 结果文本里解析 timings(cdpClickElement 透传到 MCP result JSON)
      const text = extractText(res);
      const m = text.match(/"timings"\s*:\s*\{[^}]*"attachMs"\s*:\s*(\d+)[^}]*"probeMs"\s*:\s*(\d+)[^}]*"dispatchMs"\s*:\s*(\d+)/);
      if (m) {
        lastTimings = { attachMs: Number(m[1]), probeMs: Number(m[2]), dispatchMs: Number(m[3]) };
        if (i === 0) coldAttachMs = lastTimings.attachMs;
      }
    }

    ctx.assert(cdp.length === SAMPLES, "CDP 采样不足");

    const synP50 = percentile(synthetic, 0.5);
    const cdpWarm = cdp.slice(1); // 去掉冷 attach 首样本
    const cdpP50 = percentile(cdpWarm, 0.5);

    ctx.recordMetric("syntheticP50_ms", synP50);
    ctx.recordMetric("syntheticP90_ms", percentile(synthetic, 0.9));
    ctx.recordMetric("cdpWarmP50_ms", cdpP50);
    ctx.recordMetric("cdpWarmP90_ms", percentile(cdpWarm, 0.9));
    ctx.recordMetric("cdpFirstSample_ms", cdp[0]);
    ctx.recordMetric("coldAttachMs", coldAttachMs);
    ctx.recordMetric("warmDeltaP50_ms", cdpP50 - synP50);
    if (lastTimings) {
      ctx.recordMetric("lastAttachMs", lastTimings.attachMs);
      ctx.recordMetric("lastProbeMs", lastTimings.probeMs);
      ctx.recordMetric("lastDispatchMs", lastTimings.dispatchMs);
    }
    ctx.recordMetric("sampleCount", SAMPLES);
  },
};

export default def;
