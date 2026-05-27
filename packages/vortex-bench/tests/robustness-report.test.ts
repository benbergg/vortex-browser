// packages/vortex-bench/tests/robustness-report.test.ts
import { describe, it, expect } from "vitest";
import { rankRobustnessFindings, renderRobustnessMarkdown } from "../src/robustness-report.js";
import type { RobustnessReport, RobustnessFinding, FixtureRobustness } from "../src/robustness-types.js";

const f = (over: Partial<RobustnessFinding>): RobustnessFinding => ({
  severity: "R1", fixture: "fx", ref: "@x", code: "OBSCURED", detail: "d", ...over,
});
const fx = (over: Partial<FixtureRobustness>): FixtureRobustness => ({
  fixture: "fx", path: "/p", totalRefs: 2, okCount: 2, okRate: 1, histogram: { ok: 2 }, findings: [], ...over,
});

describe("rankRobustnessFindings", () => {
  it("R0 排在 R1 前", () => {
    const ranked = rankRobustnessFindings([f({ severity: "R1" }), f({ severity: "R0", code: "crash" })]);
    expect(ranked.map((x) => x.severity)).toEqual(["R0", "R1"]);
  });
});

describe("renderRobustnessMarkdown", () => {
  it("无 R0 → 显式写契约全成立", () => {
    const report: RobustnessReport = {
      generatedAt: "2026-05-27T00:00:00Z", playgroundUrl: "http://x", fixtures: [fx({})], findings: [],
    };
    const md = renderRobustnessMarkdown(report);
    expect(md).toContain("✅ observe→act 契约全成立");
    expect(md).toContain("| fixture | 总 ref | okRate | R0 | R1 |");
    expect(md).toContain("| fx | 2 | 100% | 0 | 0 |");
  });

  it("有 R0 → 不写契约全成立, 列出 R0 段", () => {
    const finding = f({ severity: "R0", code: "ELEMENT_NOT_FOUND", ref: "@bad", detail: '[button] "x" — nope' });
    const report: RobustnessReport = {
      generatedAt: "t", playgroundUrl: "u",
      fixtures: [fx({ findings: [finding], okCount: 1, okRate: 0.5 })],
      findings: [finding],
    };
    const md = renderRobustnessMarkdown(report);
    expect(md).not.toContain("✅ observe→act 契约全成立");
    expect(md).toContain("[ELEMENT_NOT_FOUND]");
    expect(md).toContain("@bad");
  });

  it("error 行渲染(管道转义)", () => {
    const report: RobustnessReport = {
      generatedAt: "t", playgroundUrl: "u",
      fixtures: [fx({ error: "navigate 失败|超时" })], findings: [],
    };
    const md = renderRobustnessMarkdown(report);
    expect(md).toContain("⚠ error");
    expect(md).toContain("navigate 失败\\|超时");
  });

  it("R1-only(无 R0)→ 既写契约全成立 banner 又列 R1 段", () => {
    const finding = f({ severity: "R1", code: "OBSCURED", ref: "@cov", detail: '[link] "x" — covered' });
    const report: RobustnessReport = {
      generatedAt: "t", playgroundUrl: "u",
      fixtures: [fx({ findings: [finding], okCount: 1, okRate: 0.5 })],
      findings: [finding],
    };
    const md = renderRobustnessMarkdown(report);
    expect(md).toContain("✅ observe→act 契约全成立");
    expect(md).toContain("R1(actionability 降级)");
    expect(md).toContain("@cov");
  });
});
