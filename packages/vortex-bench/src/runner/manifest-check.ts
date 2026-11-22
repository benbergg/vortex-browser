// packages/vortex-bench/src/runner/manifest-check.ts
// observe 输出 vs manifest ground truth → recall/precision/name/role finding。

import type { Finding, ObserveRow, OracleRect, ParsedObserve, SynthManifest } from "../scan-types.js";
import { iou, joinByGeometry, topPageBox } from "./geometry-join.js";

/**
 * 命中行里挑「与 oracle 几何最贴合」的那行。
 * 背景:observe 输出里容器行(如 ul 的 list 行)的 bbox 中心可能正好落在子项 oracle
 * 的 rect 边界上(centerInside 含边界),于是容器行也会命中该 oracle;而容器行在输出里
 * 排在子项行之前,取 hits[0] 会拿容器的 name/role 去校验,报出假 P1
 * (期望 "首页"/menuitem,实际 "首页 关于"/list)。IoU 最大者才对应 oracle 元素本身。
 * 不按 expectedName/Role 选行——那会让校验变成同义反复,掩盖真实错配。
 */
function bestHit(
  oracle: OracleRect,
  hits: ObserveRow[],
  frameOffsets: Record<number, [number, number]>,
): ObserveRow | undefined {
  let best: ObserveRow | undefined;
  let bestIou = -1;
  for (const r of hits) {
    if (r.bbox === null) continue;
    const v = iou(oracle.rect, topPageBox(r, frameOffsets));
    if (v > bestIou) {
      bestIou = v;
      best = r;
    }
  }
  return best ?? hits[0];
}

export function checkManifest(
  parsed: ParsedObserve,
  oracles: OracleRect[],
  manifest: SynthManifest,
): Finding[] {
  const findings: Finding[] = [];
  const { matches, unmatchedRows } = joinByGeometry(parsed.rows, oracles, parsed.frameOffsets);

  for (const entry of manifest.entries) {
    const base = { fixture: manifest.fixture, pattern: entry.pattern, oracleId: entry.id };
    const oracle = oracles.find((o) => o.id === entry.id);

    // name-join 分支(跨 frame fixture):按 expectedName 在 observe 行里找
    if (entry.joinBy === "name") {
      const hit = parsed.rows.find((r) => r.name !== null && r.name === entry.expectedName);
      if (entry.interactive && !hit) {
        findings.push({ ...base, severity: "P0", kind: "recall-miss",
          detail: `name-join: observe 未输出 name="${entry.expectedName}" 的可交互元素` });
      }
      continue;
    }

    const hits = matches.get(entry.id) ?? [];
    if (entry.interactive) {
      if (hits.length === 0) {
        findings.push({ ...base, severity: "P0", kind: "recall-miss",
          detail: `interactive 元素 #${entry.id} 未被任何 observe 行命中(漏识别)` });
        continue;
      }
      // 命中:校验几何最贴合的那条命中行(容器行也会命中,见 bestHit 注释)
      const row = (oracle && bestHit(oracle, hits, parsed.frameOffsets)) ?? hits[0];
      if (!row) continue;
      if (entry.expectedName !== null && row.name !== entry.expectedName) {
        findings.push({ ...base, severity: "P1", kind: "name-mismatch", ref: row.ref,
          detail: `#${entry.id} 期望 name="${entry.expectedName}",实际 "${row.name ?? ""}"` });
      }
      if (entry.expectedRole !== null && row.role !== entry.expectedRole) {
        findings.push({ ...base, severity: "P1", kind: "role-mismatch", ref: row.ref,
          detail: `#${entry.id} 期望 role=${entry.expectedRole},实际 ${row.role}` });
      }
    } else {
      // interactive:false 却被命中 → 噪声
      if (hits.length > 0) {
        const row = (oracle && bestHit(oracle, hits, parsed.frameOffsets)) ?? hits[0];
        findings.push({ ...base, severity: "P2", kind: "precision-miss", ref: row.ref,
          detail: `#${entry.id} 标注为非交互,却被 observe 输出(噪声)` });
      }
    }
  }

  // joinBy:name 的 entry 靠 name 认领 observe 行(跨 frame 无 geometry oracle),
  // 这些行必然落在 geometry 的 unmatchedRows 里。下面噪声扫描要排除它们,
  // 否则被正确识别的跨 frame 元素会被误报成 _unannotated 噪声(自校准实测假阳)。
  const nameClaimed = new Set(
    manifest.entries
      .filter((e) => e.joinBy === "name" && e.expectedName !== null)
      .map((e) => e.expectedName as string),
  );

  // 命中不到任何 oracle 的 observe 行:记为 P2 噪声(fixture 应标全;未标元素从轻)
  for (const row of unmatchedRows) {
    if (row.name !== null && nameClaimed.has(row.name)) continue; // 已被 name-join 认领
    findings.push({ fixture: manifest.fixture, pattern: "_unannotated", severity: "P2",
      kind: "precision-miss", ref: row.ref,
      detail: `observe 行 ${row.ref} [${row.role}] "${row.name ?? ""}" 未匹配任何 oracle 标注` });
  }

  return findings;
}
