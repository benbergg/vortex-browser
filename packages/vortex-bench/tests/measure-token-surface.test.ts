/**
 * Author: qingwa
 * Description: 测量脚本的固定比较集合护栏。
 *
 * 背景（最终整体评审 Important 4）：`measure-token-surface.mjs --compare` 原先直接
 * 聚合报告里的所有 case，不校验 suite、不校验基线的 99 个名称、不查重复/缺失 ——
 * 于是"只含一个无关低输出 case"的报告也能 PASS，回归会被稀释掉。
 *
 * 契约：
 * - 比较集合以 baseline.json 的 case 名称集合为准；
 * - 只聚合该集合内的 case（suite B 的 case 不参与 A10/A11）；
 * - 缺失 / 重复 / 混入非集合项 ⇒ 明确报错并拒绝比较（非零退出），不静默跳过。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  baselineCaseNames,
  selectComparableCases,
  benchReport,
} from "../../../scripts/measure-token-surface.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "measure-token-surface.mjs");

/** 造一份报告：cases 是 {case, suite?} 的最小形态。 */
function makeReport(cases: Array<{ case: string; suite?: string; outputBytes?: number }>) {
  return {
    generatedAt: "2026-10-23T00:00:00.000Z",
    playgroundUrl: "http://127.0.0.1:4173",
    cases: cases.map((c, i) => ({
      case: c.case,
      passed: true,
      callCount: 1,
      outputBytes: c.outputBytes ?? 100,
      durationMs: 1,
      outputBytesByTool: {},
      ...(c.suite ? { suite: c.suite } : {}),
      _i: i,
    })),
  };
}

describe("比较集合按基线固定名称校验", () => {
  it("基线名称集合来自 baseline.json（99 条且不重复）", () => {
    const names = baselineCaseNames();
    expect(names.length).toBe(99);
    expect(new Set(names).size).toBe(99);
  });

  it("集合完全匹配时正常聚合（只聚合集合内的 case）", () => {
    const names = baselineCaseNames();
    const cases = names.map((n) => ({ case: n }));
    const picked = selectComparableCases(cases, names);
    expect(picked.cases.length).toBe(99);
    expect(picked.suiteBCases).toBe(0);
  });

  it("suite B 的 case 不参与比较，也不算「混入非比较项」", () => {
    const names = baselineCaseNames();
    const cases = [
      ...names.map((n) => ({ case: n })),
      { case: "contract/not-found-page", suite: "b" },
      { case: "contract/event-isolation", suite: "b" },
    ];
    const picked = selectComparableCases(cases, names);
    expect(picked.cases.length).toBe(99);
    expect(picked.suiteBCases).toBe(2);
  });

  it("缺失基线 case ⇒ 报错并拒绝比较", () => {
    const names = baselineCaseNames();
    const cases = names.slice(1).map((n) => ({ case: n }));
    expect(() => selectComparableCases(cases, names)).toThrow(/缺失/);
  });

  it("重复 case ⇒ 报错并拒绝比较", () => {
    const names = baselineCaseNames();
    const cases = [...names.map((n) => ({ case: n })), { case: names[0] }];
    expect(() => selectComparableCases(cases, names)).toThrow(/重复/);
  });

  it("混入非比较项 ⇒ 报错并拒绝比较", () => {
    const names = baselineCaseNames();
    const cases = [...names.map((n) => ({ case: n })), { case: "unrelated-low-output-case" }];
    expect(() => selectComparableCases(cases, names)).toThrow(/混入非比较项/);
  });

  it("只有无关低输出 case 的报告不再能 PASS（正是评审点名的漏法）", () => {
    const names = baselineCaseNames();
    const cases = [{ case: "unrelated-low-output-case", outputBytes: 1 }];
    expect(() => selectComparableCases(cases, names)).toThrow();
  });

  it("benchReport 在集合不一致时抛错（不产出可比较的报告）", () => {
    const names = baselineCaseNames();
    const dir = mkdtempSync(join(tmpdir(), "vortex-token-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(makeReport([{ case: "unrelated-low-output-case" }])), "utf8");
    try {
      expect(() => benchReport(bad, { baselineNames: names })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("脚本以 --compare 比较不一致的报告时非零退出并说明原因", () => {
    const names = baselineCaseNames();
    const dir = mkdtempSync(join(tmpdir(), "vortex-token-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(makeReport([{ case: "unrelated-low-output-case" }])), "utf8");
    try {
      let code = 0;
      let stderr = "";
      try {
        execFileSync(process.execPath, [SCRIPT, "--compare", bad], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        code = err.status ?? 1;
        stderr = String(err.stderr ?? "");
      }
      expect(code, "比较集合不一致时必须非零退出").not.toBe(0);
      expect(stderr).toMatch(/缺失/);
      expect(stderr).toMatch(/混入非比较项/);
      // 基线里的 99 条必须被点名（缺失清单）
      expect(stderr).toContain(names[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
