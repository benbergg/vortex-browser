// packages/vortex-bench/src/runner/judge-consistency.ts
// 纯逻辑:两轮 ClaimedMiss 取空间交集(自一致过滤抖动)。保留 a 侧表述。

import type { ClaimedMiss } from "../judge-types.js";
import { boxesMatch } from "./geometry-join.js";

export function intersectPasses(a: ClaimedMiss[], b: ClaimedMiss[]): ClaimedMiss[] {
  return a.filter((ma) => b.some((mb) => boxesMatch(ma.bbox, mb.bbox)));
}
