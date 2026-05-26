// packages/vortex-bench/src/scan-report.ts
// finding 排序 + markdown 报告渲染。json 报告直接 JSON.stringify(report)。

import type { Finding, ScanReport } from "./scan-types.js";

const SEV_ORDER: Record<Finding["severity"], number> = { P0: 0, P1: 1, P2: 2 };

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

export function renderScanMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push("# vortex scan 报告");
  lines.push("");
  lines.push(`- 生成时间: ${report.generatedAt}`);
  lines.push(`- playground: ${report.playgroundUrl}`);
  lines.push(`- fixture 数: ${report.fixtures.length}  候选 finding 数: ${report.findings.length}`);
  lines.push("");

  // 汇总表
  lines.push("## 汇总(per-fixture)");
  lines.push("");
  lines.push("| fixture | pattern | recall | precision(noise/emit) | INV1 | INV2 | INV3 | INV4 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const fx of report.fixtures) {
    const inv = (b: boolean) => (b ? "✓" : "✗");
    lines.push(
      `| ${fx.fixture} | ${fx.pattern} | ${fx.recall.matched}/${fx.recall.expected} | ` +
      `${fx.precision.matchedNoise}/${fx.precision.emitted} | ${inv(fx.invariants.inv1)} | ` +
      `${inv(fx.invariants.inv2)} | ${inv(fx.invariants.inv3)} | ${inv(fx.invariants.inv4)} |`,
    );
    if (fx.error) lines.push(`| ↳ ⚠ error | ${fx.error.replace(/\|/g, "\\|")} | | | | | | |`);
  }
  lines.push("");

  // 按严重度分组的 finding
  const ranked = rankFindings(report.findings);
  if (ranked.length === 0) {
    lines.push("## 候选 finding");
    lines.push("");
    lines.push("> ✅ 未发现候选 —— 当前 vortex 在合成语料上 P0/P1/P2 全清。");
    return lines.join("\n");
  }
  for (const sev of ["P0", "P1", "P2"] as const) {
    const group = ranked.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${sev}(${group.length})`);
    lines.push("");
    for (const f of group) {
      const ref = f.ref ? ` \`${f.ref}\`` : "";
      lines.push(`- **[${f.kind}]** \`${f.fixture}\`/${f.pattern}${ref} — ${f.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
