/**
 * Author: qingwa
 * Description: compare-cdp 双模式对比的归类/汇总。
 *
 * CDP-first 转正(2026-06-11)后默认即 CDP,两 pass 重定义:
 *   pass A(SYNTHETIC_BASELINE)= forceSynthetic 合成降级路径(value-setter/dispatch);
 *   pass B(CDP_FIRST)= 默认 CDP-first(useRealMouse 让 click 走 strict CDP 不降级)。
 * 用于持续监控合成降级路径不退化 + CDP-first 无新 regression。
 * 注:cdpFill/cdpType 实验开关已随转正退役(dom.ts 默认即 insertText,该参数不再读)。
 */
import type { CaseMetrics } from "./types.js";

/** pass B:CDP-first(转正后即默认;useRealMouse 让 click 走 strict CDP 不降级合成)。 */
export const CDP_FIRST_OVERRIDES: Record<string, Record<string, unknown>> = {
  vortex_act: { useRealMouse: true },
};

/** pass A:合成降级对照(forceSynthetic 压过 CDP-first,还原 value-setter/dispatch 路径)。 */
export const SYNTHETIC_BASELINE_OVERRIDES: Record<string, Record<string, unknown>> = {
  vortex_act: { forceSynthetic: true },
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
