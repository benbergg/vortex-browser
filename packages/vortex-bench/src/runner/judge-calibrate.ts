// packages/vortex-bench/src/runner/judge-calibrate.ts
// 纯逻辑:消融抽行(确定性)+ synth FP/TP 校准统计。

import type { ObserveRow } from "../scan-types.js";
import type { ClaimedMiss, CalibrationStats } from "../judge-types.js";
import { labelsMatch } from "./judge-match.js";

/** 合格行 = 主 frame + 有 bbox;按面积降序取前 k 抽掉(确定性,可复现) */
export function ablateRows(rows: ObserveRow[], k: number): { kept: ObserveRow[]; ablated: ObserveRow[] } {
  const eligible = rows.filter((r) => r.frameId === 0 && r.bbox !== null);
  const ranked = [...eligible].sort((a, b) => area(b.bbox!) - area(a.bbox!));
  const ablated = ranked.slice(0, k);
  const ablatedRefs = new Set(ablated.map((r) => r.ref));
  const kept = rows.filter((r) => !ablatedRefs.has(r.ref));
  return { kept, ablated };
}

function area(b: [number, number, number, number]): number {
  return b[2] * b[3];
}

/**
 * @param fpMisses  原样列表 2 轮交集后判官报的 miss(synth 干净页理想空)
 * @param tpMisses  抽行列表喂判官后报的 miss
 * @param ablated   被抽掉的行
 */
export function computeCalibration(
  fpMisses: ClaimedMiss[],
  tpMisses: ClaimedMiss[],
  ablated: ObserveRow[],
): CalibrationStats {
  let recovered = 0;
  for (const r of ablated) {
    // label exact 匹配:被抽行的 accessible name 与判官报的 miss label 规范化后相等。
    // 替代旧 bbox 匹配的原因:Doubao/MiniMax 等多模态模型 bbox 在归一化坐标系
    // 不兼容 viewport 像素。代价:同 label 多元素时 recovered 计数会偏宽松
    // (任一同名 kept 行匹配也算),live 解读时知情;排他校验留 backlog。
    if (tpMisses.some((m) => labelsMatch(m.label, r.name))) recovered++;
  }
  return {
    fpConfirmed: fpMisses.length,
    ablatedCount: ablated.length,
    ablatedRecovered: recovered,
  };
}
