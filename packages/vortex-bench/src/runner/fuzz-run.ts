// packages/vortex-bench/src/runner/fuzz-run.ts
// fuzz 跑一页:写临时 html → 跑 scanFixture → 提取分歧。
// 纯函数(extractDiscrepancies / selfTestPassed)离线可测;runPage 需活 MCP(后续任务追加)。

import type { FixtureScanResult } from "../scan-types.js";
import type { FuzzFinding } from "../fuzz-types.js";

const STRUCTURAL_KINDS = new Set(["recall-miss", "precision-miss"]);

/** scan 结果 → fuzz finding(只取 recall/precision/name,忽略 invariant) */
export function extractDiscrepancies(seed: number, scan: FixtureScanResult): FuzzFinding[] {
  const out: FuzzFinding[] = [];
  for (const f of scan.findings) {
    if (f.kind === "recall-miss" || f.kind === "precision-miss") {
      out.push({ seed, cls: "structural", kind: f.kind, detail: f.detail, oracleId: f.oracleId });
    } else if (f.kind === "name-mismatch") {
      out.push({ seed, cls: "name", kind: "name-mismatch", detail: f.detail, oracleId: f.oracleId });
    }
    // inv*-/role-mismatch 不进 fuzz finding(首切聚焦 observe 漏报/误报/命名)
  }
  return out;
}

/** 原语单体自检:任一单体页出结构性 finding → 自检失败(契约未对齐/原语自身 bug) */
export function selfTestPassed(soloScans: FixtureScanResult[]): boolean {
  return soloScans.every((s) => !s.findings.some((f) => STRUCTURAL_KINDS.has(f.kind)));
}
