// packages/vortex-bench/src/runner/propose-manifest.ts
// 候选(proposer)+ observe 行 → delta 分类 + 提议 manifest。
// 复用 #1 的 joinByGeometry:候选当 oracles,observe 行当 rows。

import { joinByGeometry } from "./geometry-join.js";
import type { ObserveRow, OracleRect } from "../scan-types.js";
import type { ProposedEntry, ProposedManifest, RawCandidate, ReviewTag } from "../snapshot-types.js";

export interface ProposeMeta {
  fixture: string;
  path: string;
  source: string;
  capturedAt: string;
  frames?: "main" | "all-same-origin" | "all-permitted";
}

const REVIEW_ORDER: Record<ReviewTag, number> = { "observe-missed": 0, "observe-extra": 1, agree: 2 };

export function proposeManifest(
  candidates: RawCandidate[],
  observeRows: ObserveRow[],
  meta: ProposeMeta,
): ProposedManifest {
  const oracles: OracleRect[] = candidates.map((c) => ({ id: c.id, rect: c.bbox }));
  const { matches, unmatchedRows } = joinByGeometry(observeRows, oracles, {});

  const entries: ProposedEntry[] = [];

  // 候选 → agree(有 observe 命中)/ observe-missed(无)
  for (const c of candidates) {
    const hit = (matches.get(c.id) ?? []).length > 0;
    entries.push({
      id: c.id,
      interactive: true,
      expectedName: c.name,
      expectedRole: c.role,
      pattern: c.pattern,
      _review: hit ? "agree" : "observe-missed",
    });
  }

  // observe 行无候选命中 → observe-extra(冻结页无 data-vtx-oracle,按 name 匹配)
  let extraSeq = 0;
  for (const r of unmatchedRows) {
    entries.push({
      id: `extra-${extraSeq++}`,
      interactive: true,
      expectedName: r.name,
      expectedRole: r.role,
      pattern: "_observe-extra",
      joinBy: "name",
      _review: "observe-extra",
    });
  }

  entries.sort((a, b) => REVIEW_ORDER[a._review] - REVIEW_ORDER[b._review]);

  return {
    fixture: meta.fixture,
    path: meta.path,
    frames: meta.frames ?? "main",
    source: meta.source,
    capturedAt: meta.capturedAt,
    _proposed: true,
    entries,
  };
}
