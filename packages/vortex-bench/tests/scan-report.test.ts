// packages/vortex-bench/tests/scan-report.test.ts
import { describe, it, expect } from "vitest";
import { rankFindings, renderScanMarkdown } from "../src/scan-report.js";
import type { Finding, ScanReport } from "../src/scan-types.js";

const f = (severity: Finding["severity"], kind: Finding["kind"]): Finding =>
  ({ severity, kind, fixture: "t", pattern: "p", detail: "d" });

describe("rankFindings", () => {
  it("P0 排在 P1 前,P1 排在 P2 前", () => {
    const sorted = rankFindings([f("P2", "inv3-duplicate"), f("P0", "recall-miss"), f("P1", "name-mismatch")]);
    expect(sorted.map((x) => x.severity)).toEqual(["P0", "P1", "P2"]);
  });
});

describe("renderScanMarkdown", () => {
  it("含汇总表 + 按严重度分组的 finding", () => {
    const report: ScanReport = {
      generatedAt: "2026-05-26T00:00:00Z",
      playgroundUrl: "http://localhost:5173",
      fixtures: [{
        fixture: "cursor-pointer-div", pattern: "cursor-pointer-div", path: "/synth/cursor-pointer-div.html",
        recall: { matched: 1, expected: 2 }, precision: { matchedNoise: 0, emitted: 3 },
        invariants: { inv1: true, inv2: true, inv3: true, inv4: true },
        findings: [f("P0", "recall-miss")],
      }],
      findings: [f("P0", "recall-miss")],
    };
    const md = renderScanMarkdown(report);
    expect(md).toContain("# vortex scan 报告");
    expect(md).toContain("cursor-pointer-div");
    expect(md).toContain("1/2"); // recall
    expect(md).toContain("P0");
    expect(md).toContain("recall-miss");
  });

  it("零 finding 时显式写「未发现候选」", () => {
    const report: ScanReport = { generatedAt: "t", playgroundUrl: "u", fixtures: [], findings: [] };
    expect(renderScanMarkdown(report)).toContain("未发现候选");
  });
});
