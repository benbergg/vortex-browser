// packages/vortex-bench/src/judge-report.ts
// 纯逻辑:judge 报告 md 渲染。live 列 recall-miss;synth 加校准 FP/TP 表。json 直接 JSON.stringify。

import type { JudgeReport } from "./judge-types.js";

export function renderJudgeMarkdown(report: JudgeReport): string {
  const lines: string[] = [];
  lines.push("# vortex judge 报告(漏斗塔尖:LLM 判 observe recall-miss)");
  lines.push("");
  lines.push(`- 生成时间: ${report.generatedAt}`);
  lines.push(`- 模型: ${report.model}`);
  lines.push(`- 模式: ${report.mode}`);
  lines.push(`- profile: ${report.profile?.name ?? "q70-default"}`);
  lines.push(`- page 数: ${report.pages.length}  recall-miss: ${report.findings.length}`);
  lines.push("");

  if (report.mode === "synth") {
    lines.push("## 校准(消融 FP/TP)");
    lines.push("");
    lines.push("| page | 假阳(原样交集 miss) | 查全(重发现/抽掉) |");
    lines.push("|---|---|---|");
    for (const p of report.pages) {
      const c = p.calibration;
      const fp = c ? String(c.fpConfirmed) : "-";
      const tp = c ? `${c.ablatedRecovered}/${c.ablatedCount}` : "-";
      lines.push(`| ${p.page} | ${fp} | ${tp} |${p.error ? ` ⚠ ${p.error}` : ""}`);
    }
    lines.push("");
  }

  if (report.findings.length === 0) {
    lines.push("> ✅ 未发现 observe 漏发(judge 抽样口径下)。");
    lines.push("");
  } else {
    lines.push(`## recall-miss — ${report.findings.length}`);
    lines.push("");
    for (const f of report.findings) {
      lines.push(`- \`${f.fixture}\` — ${f.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
