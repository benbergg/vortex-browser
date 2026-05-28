// packages/vortex-bench/src/runner/judge-consistency.ts
// 纯逻辑:两轮 ClaimedMiss 取 label 交集(自一致过滤抖动)。保留 a 侧表述。
//
// 早期实现用 bbox 几何重叠(boxesMatch),Doubao/MiniMax 等模型 bbox 在归一化
// 坐标系不兼容 → 改为 label exact(case-insensitive + trim),跨模型稳定。

import type { ClaimedMiss } from "../judge-types.js";
import { normalizeLabel } from "./judge-match.js";

export function intersectPasses(a: ClaimedMiss[], b: ClaimedMiss[]): ClaimedMiss[] {
  const bLabels = new Set(b.map((m) => normalizeLabel(m.label)));
  return a.filter((ma) => bLabels.has(normalizeLabel(ma.label)));
}
