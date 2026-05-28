// packages/vortex-bench/src/runner/judge-calibrate.ts
// 纯逻辑:消融抽行(确定性)+ synth FP/TP 校准统计。

import type { ObserveRow } from "../scan-types.js";
import type { ClaimedMiss, CalibrationStats } from "../judge-types.js";
import { boxesMatch } from "./geometry-join.js";

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
    // 注意:boxesMatch 采用宽松匹配(IoU≥0.3 或互相中心落入)。
    // tpMiss 可能匹配到被抽行附近的 kept 元素(而非真正重发现被抽元素),
    // 导致查全率(ablatedRecovered / ablatedCount)偏宽松。
    // live 解读时知情;排他校验(确保命中的 miss 不对应任何 kept 行)留 backlog。
    if (r.bbox && tpMisses.some((m) => boxesMatch(r.bbox!, m.bbox))) recovered++;
  }
  return {
    fpConfirmed: fpMisses.length,
    ablatedCount: ablated.length,
    ablatedRecovered: recovered,
  };
}
