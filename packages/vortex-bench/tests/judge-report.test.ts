// packages/vortex-bench/tests/judge-report.test.ts
import { describe, it, expect } from "vitest";
import { renderJudgeMarkdown } from "../src/judge-report.js";
import type { JudgeReport, JudgePageResult } from "../src/judge-types.js";
import type { Finding } from "../src/scan-types.js";

const finding = (over: Partial<Finding>): Finding => ({
  severity: "P0", kind: "recall-miss", fixture: "web.dev", pattern: "_judge", detail: "搜索 @[1,2,3,4] — 放大镜", ...over,
});
const page = (over: Partial<JudgePageResult>): JudgePageResult => ({
  page: "web.dev", totalObserveRows: 10, confirmedMisses: [], findings: [], ...over,
});

describe("renderJudgeMarkdown", () => {
  it("live 模式列出 recall-miss findings", () => {
    const f = finding({});
    const report: JudgeReport = {
      generatedAt: "t", model: "claude-sonnet-4-6", mode: "live", pages: [page({ findings: [f] })], findings: [f],
    };
    const md = renderJudgeMarkdown(report);
    expect(md).toContain("recall-miss");
    expect(md).toContain("搜索 @[1,2,3,4]");
    expect(md).toContain("claude-sonnet-4-6");
  });
  it("无 finding → 显式写未发现漏发", () => {
    const report: JudgeReport = {
      generatedAt: "t", model: "m", mode: "live", pages: [page({})], findings: [],
    };
    expect(renderJudgeMarkdown(report)).toContain("✅");
  });
  it("synth 模式渲染校准 FP/TP 表", () => {
    const report: JudgeReport = {
      generatedAt: "t", model: "m", mode: "synth",
      pages: [page({ calibration: { fpConfirmed: 0, ablatedCount: 3, ablatedRecovered: 2 } })],
      findings: [],
    };
    const md = renderJudgeMarkdown(report);
    expect(md).toContain("校准");
    expect(md).toContain("2/3"); // ablatedRecovered/ablatedCount
  });
});
