// packages/vortex-bench/src/runner/invariants.ts
// C 不变量的纯逻辑部分。INV-2 的探针「执行」在 scan.ts(需活 MCP),
// 这里只做结果「分类」(classifyProbe),保持本文件 100% 离线可测。

import type { Finding, ObserveRow, ParsedObserve } from "../scan-types.js";

type Box = [number, number, number, number];

/** 两个 box 的 IoU(交并比) */
export function iou(a: Box, b: Box): number {
  const ix = Math.max(a[0], b[0]);
  const iy = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const iy2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const iw = Math.max(0, ix2 - ix);
  const ih = Math.max(0, iy2 - iy);
  const inter = iw * ih;
  if (inter === 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union === 0 ? 0 : inter / union;
}

/** 元素的稳定性身份:role + name(bbox 抖动不计入身份,只看语义集合) */
function identity(r: ObserveRow): string {
  return `${r.role} ${r.name ?? ""}`;
}

/** INV-1:无 mutation 连跑两次 observe,可交互集合(role+name 计数)必须一致 */
export function checkStability(a: ParsedObserve, b: ParsedObserve, fixture: string, pattern: string): Finding[] {
  const count = (rows: ObserveRow[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(identity(r), (m.get(identity(r)) ?? 0) + 1);
    return m;
  };
  const ca = count(a.rows);
  const cb = count(b.rows);
  const keys = new Set([...ca.keys(), ...cb.keys()]);
  const diffs: string[] = [];
  for (const k of keys) {
    const na = ca.get(k) ?? 0;
    const nb = cb.get(k) ?? 0;
    if (na !== nb) diffs.push(`${k.replace(" ", "/")}: ${na}→${nb}`);
  }
  if (diffs.length === 0) return [];
  return [{ fixture, pattern, severity: "P1", kind: "inv1-instability",
    detail: `两次 observe 集合不一致: ${diffs.join("; ")}` }];
}

export interface ProbeResult { text: string; threw: boolean; timedOut: boolean; }

/** INV-2:把一次 ref 探针的结果分类。typed-error / ok 都算 PASS,crash 是 FAIL。 */
export function classifyProbe(p: ProbeResult): "ok" | "typed-error" | "crash" {
  if (p.threw || p.timedOut) return "crash";
  if (/^Error \[[A-Z_]+\]:/m.test(p.text)) return "typed-error";
  return "ok";
}

/** INV-3:同 role+name 且 bbox IoU>0.5 的两行视为重复 */
export function checkDuplicates(rows: ObserveRow[], fixture: string, pattern: string): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (identity(a) !== identity(b)) continue;
      if (a.bbox === null || b.bbox === null) continue;
      if (iou(a.bbox, b.bbox) > 0.5) {
        findings.push({ fixture, pattern, severity: "P2", kind: "inv3-duplicate", ref: b.ref,
          detail: `重复行 ${a.ref} 与 ${b.ref}: [${a.role}] "${a.name ?? ""}"` });
      }
    }
  }
  return findings;
}

/** INV-4:bbox 合法性。需要 viewport 求边界;无 viewport 时跳过越界类检查。 */
export function checkBboxSanity(parsed: ParsedObserve, fixture: string, pattern: string): Finding[] {
  const findings: Finding[] = [];
  const vp = parsed.header.viewport;
  for (const r of parsed.rows) {
    if (r.bbox === null) continue;
    const [x, y, w, h] = r.bbox;
    const bad: string[] = [];
    if (w <= 0 || h <= 0) bad.push(`退化尺寸 ${w}x${h}`);
    if (x < 0 || y < 0) bad.push(`负坐标 (${x},${y})`);
    // 视口越界类只对主 frame 判定:子 frame 元素坐标是 frame-local,
    // 拿主 frame viewport 比会假阳。退化尺寸/负坐标对所有 frame 都查。
    if (vp && r.frameId === 0) {
      if (w > vp.width * 2) bad.push(`宽 ${w} 超视口 2 倍(${vp.width})`);
      if (y > vp.scrollHeight + 50) bad.push(`y=${y} 超文档高 ${vp.scrollHeight}`);
    }
    if (bad.length) {
      findings.push({ fixture, pattern, severity: "P2", kind: "inv4-bbox", ref: r.ref,
        detail: `bbox 异常 [${r.bbox.join(",")}]: ${bad.join(", ")}` });
    }
  }
  return findings;
}
