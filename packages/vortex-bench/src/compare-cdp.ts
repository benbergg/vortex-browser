/**
 * Author: qingwa
 * Description: spike(cdp-first 阶段0) — compare-cdp 双模式对比的归类/汇总。
 *
 * pass A = 现状默认(合成事件优先);pass B = CDP-first(useRealMouse + cdpFill +
 * cdpType 实验开关,见 extension dom.ts 实验分支)。决策矩阵的核心输入是
 * cdpRegressions(baseline 过而 CDP 挂)与 cdpFixes(baseline 挂而 CDP 裸过)。
 */
import type { CaseMetrics } from "./types.js";

/** pass B 的 argOverrides:click 走 CDP 真鼠标,fill/type 走 CDP insertText。 */
export const CDP_FIRST_OVERRIDES: Record<string, Record<string, unknown>> = {
  // vortex_act 按 action 分发到 dom.click/fill/type,各 handler 只读自己的
  // 开关,多余参数惰性忽略,故三个旋钮一起给。
  vortex_act: { useRealMouse: true, cdpFill: true, cdpType: true },
  vortex_fill: { cdpFill: true },
};

export type CdpVerdict = "both-pass" | "cdp-regression" | "cdp-fixes" | "both-fail";

export interface CdpCompareRow {
  case: string;
  baselinePassed: boolean;
  cdpPassed: boolean;
  verdict: CdpVerdict;
  baselineMs: number;
  cdpMs: number;
}

export interface CdpCompareSummary {
  generatedAt: string;
  /** 两侧都有结果的 case 数(单侧缺失不计) */
  total: number;
  bothPass: number;
  cdpRegressions: string[];
  cdpFixes: string[];
  bothFail: string[];
  rows: CdpCompareRow[];
}

function verdictOf(baselinePassed: boolean, cdpPassed: boolean): CdpVerdict {
  if (baselinePassed && cdpPassed) return "both-pass";
  if (baselinePassed) return "cdp-regression";
  if (cdpPassed) return "cdp-fixes";
  return "both-fail";
}

export function summarizeCdpCompare(
  before: CaseMetrics[],
  after: CaseMetrics[],
): CdpCompareSummary {
  const afterByName = new Map(after.map((m) => [m.case, m]));
  const rows: CdpCompareRow[] = [];
  for (const b of before) {
    const a = afterByName.get(b.case);
    if (!a) continue; // 单侧缺失(runPass 异常中断)不进对比
    rows.push({
      case: b.case,
      baselinePassed: b.passed,
      cdpPassed: a.passed,
      verdict: verdictOf(b.passed, a.passed),
      baselineMs: b.durationMs,
      cdpMs: a.durationMs,
    });
  }
  return {
    generatedAt: "",
    total: rows.length,
    bothPass: rows.filter((r) => r.verdict === "both-pass").length,
    cdpRegressions: rows.filter((r) => r.verdict === "cdp-regression").map((r) => r.case),
    cdpFixes: rows.filter((r) => r.verdict === "cdp-fixes").map((r) => r.case),
    bothFail: rows.filter((r) => r.verdict === "both-fail").map((r) => r.case),
    rows,
  };
}

export function renderCdpCompareTable(s: CdpCompareSummary): string {
  const lines: string[] = [];
  lines.push("case                                     | baseline | cdp-first | verdict        | ms(base→cdp)");
  lines.push("-".repeat(110));
  for (const r of s.rows) {
    lines.push(
      `${r.case.padEnd(40)} | ${r.baselinePassed ? "pass" : "FAIL"}     | ${
        r.cdpPassed ? "pass" : "FAIL"
      }      | ${r.verdict.padEnd(14)} | ${r.baselineMs}→${r.cdpMs}`,
    );
  }
  lines.push("");
  lines.push(
    `total=${s.total}  both-pass=${s.bothPass}  cdp-regression=${s.cdpRegressions.length}  cdp-fixes=${s.cdpFixes.length}  both-fail=${s.bothFail.length}`,
  );
  if (s.cdpRegressions.length > 0) lines.push(`cdp-regression: ${s.cdpRegressions.join(", ")}`);
  if (s.cdpFixes.length > 0) lines.push(`cdp-fixes: ${s.cdpFixes.join(", ")}`);
  return lines.join("\n");
}
