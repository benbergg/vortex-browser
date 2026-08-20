// 深 DOM 压测报告渲染。纯函数,离线可测。
// 刻意不产出"是否达标"的结论:耗时噪声 1.4×,给个绿灯只会制造假安全感。
// 唯一的红灯来自结构真值比对(见 perf-corpus.checkStructure)。

import type { PerfReport, PerfRun, DimensionSample } from "./perf-types.js";

/** 取中位数。样本少且分布偏斜,均值会被单次抖动拉走。 */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 最慢/最快倍数。用来提醒读者这组数字有多不稳,而不是拿去判定。 */
export function spread(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const lo = Math.min(...xs);
  return lo === 0 ? 0 : Math.round((Math.max(...xs) / lo) * 10) / 10;
}

/**
 * 按中位耗时从贵到便宜排。相邻两项差距小于它们自身的抖动时,次序是噪声排出来的,
 * 用 ~ 连接表示分不出先后 —— 实测见过 box(253ms,1.2×) 排在 geometry(200ms,1.3×) 前面。
 */
export function rankDimensions(run: PerfRun): string[] {
  const sorted = [...run.samples].sort((a, b) => median(b.msSamples) - median(a.msSamples));
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    const tied =
      prev !== undefined &&
      median(prev.msSamples) / Math.max(median(cur.msSamples), 1) <
        Math.max(spread(prev.msSamples), spread(cur.msSamples));
    if (tied) out[out.length - 1] = `${out[out.length - 1]}~${cur.dimension}`;
    else out.push(cur.dimension);
  }
  return out;
}

function row(s: DimensionSample): string {
  const p50 = median(s.msSamples);
  return `| ${s.dimension} | ${p50.toFixed(1)} | ${spread(s.msSamples)}× | ${s.hitTests} | ${s.ancestorSteps} |`;
}

export function renderPerfReport(report: PerfReport): string {
  const lines: string[] = [
    "# 深 DOM 成本归因",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 浏览器：${report.browser}`,
    "",
    "> 耗时是**参考量**不是判据：同一调用重复多轮本就有倍级抖动，任何墙钟阈值都会 flaky。",
    "> 可阻断的只有结构真值（节点数、上溯步数），它们是确定量。",
    "",
  ];

  for (const run of report.runs) {
    lines.push(`## ${run.shapeId}`, "");
    lines.push(`- DOM 节点：${run.domNodes}　匹配元素：${run.matched}`);
    lines.push(`- 成本次序（贵 → 便宜）：${rankDimensions(run).join(" > ")}`, "");
    lines.push("| 维度 | 中位耗时 ms | 抖动 | 命中测试次数 | 祖先上溯步数 |");
    lines.push("|---|---|---|---|---|");
    for (const s of run.samples) lines.push(row(s));
    lines.push("");
    if (run.structuralMismatches.length > 0) {
      lines.push("**结构真值不符（这是红灯）：**", "");
      for (const m of run.structuralMismatches) lines.push(`- ${m}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** 汇总红灯。压测的退出码只看这个,不看耗时。 */
export function collectMismatches(report: PerfReport): string[] {
  return report.runs.flatMap((r) => r.structuralMismatches);
}
