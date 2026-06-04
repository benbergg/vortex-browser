// 评测门统一 eval:合并 A 层(scanFixture 召回)+ B 层(runCase 任务结局),按 tier
// 聚合成分档汇总,供 eval-report 渲染与 eval --gate 比对。
//
// aggregateEval 是纯函数(无浏览器),可单测;runEval 编排实跑(需 Chrome 桥,Phase 2)。

import { scanFixture, type ScanOptions } from "./scan.js";
import { runCase, classifyCaseOutcome } from "./run-case.js";
import type { FixtureScanResult, SynthManifest } from "../scan-types.js";
import type { CaseDefinition, CaseMetrics } from "../types.js";

export type Tier = "easy" | "medium" | "hard";
export const TIER_ORDER: Tier[] = ["easy", "medium", "hard"];

export interface EvalTierSummary {
  tier: Tier;
  // A 层召回(scanFixture)
  recallMatched: number;
  recallExpected: number;
  recallNoise: number; // precision FP(matchedNoise)
  fixtureCount: number;
  // B 层任务(runCase,经 classifyCaseOutcome 三态)
  taskPass: number;
  taskDegraded: number; // 优雅降级(evaluate 兜底)= 软扣分
  taskFail: number;
  caseCount: number;
}

export interface EvalResult {
  generatedAt: string;
  tiers: EvalTierSummary[];
}

/**
 * 纯聚合:把 A 层 scan 结果与 B 层 case 指标按 tier 合并。
 * - scan 缺省 tier 归 medium(与 scanFixture 兜底一致)。
 * - case 无 tier(工具管线类)不计入任何档的任务统计——它们测工具本身,非真实站任务。
 */
export function aggregateEval(
  scans: FixtureScanResult[],
  cases: CaseMetrics[],
): EvalTierSummary[] {
  const byTier = new Map<Tier, EvalTierSummary>();
  const ensure = (t: Tier): EvalTierSummary => {
    let s = byTier.get(t);
    if (!s) {
      s = {
        tier: t, recallMatched: 0, recallExpected: 0, recallNoise: 0, fixtureCount: 0,
        taskPass: 0, taskDegraded: 0, taskFail: 0, caseCount: 0,
      };
      byTier.set(t, s);
    }
    return s;
  };

  for (const sc of scans) {
    const s = ensure((sc.tier as Tier) ?? "medium");
    s.recallMatched += sc.recall.matched;
    s.recallExpected += sc.recall.expected;
    s.recallNoise += sc.precision.matchedNoise;
    s.fixtureCount += 1;
  }

  for (const c of cases) {
    if (c.tier == null) continue; // 工具管线类:不计入任务统计
    const s = ensure(c.tier);
    s.caseCount += 1;
    const outcome = classifyCaseOutcome(c);
    if (outcome === "pass") s.taskPass += 1;
    else if (outcome === "pass-degraded") s.taskDegraded += 1;
    else s.taskFail += 1;
  }

  return TIER_ORDER.filter((t) => byTier.has(t)).map((t) => byTier.get(t)!);
}

export interface RunEvalOptions {
  mcpBin: string;
  playgroundUrl: string;
  manifests: SynthManifest[];
  cases: CaseDefinition[];
  generatedAt: string; // 调用方注入(脚本内禁用 Date.now);ISO 串
}

/**
 * 编排实跑(需 Chrome 桥):scanFixture 全 synth 语料 + runCase 全 tier-tagged case
 * → aggregateEval。Phase 2 验证;此处不在单测覆盖(依赖浏览器)。
 */
export async function runEval(opts: RunEvalOptions): Promise<EvalResult> {
  const scanOpts: ScanOptions = { mcpBin: opts.mcpBin, playgroundUrl: opts.playgroundUrl };
  const scans: FixtureScanResult[] = [];
  for (const m of opts.manifests) {
    scans.push(await scanFixture(m, scanOpts));
  }
  const metrics: CaseMetrics[] = [];
  for (const def of opts.cases) {
    metrics.push(await runCase(def, { mcpBin: opts.mcpBin, playgroundUrl: opts.playgroundUrl }));
  }
  return { generatedAt: opts.generatedAt, tiers: aggregateEval(scans, metrics) };
}
