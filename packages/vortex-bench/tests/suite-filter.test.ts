// packages/vortex-bench/tests/suite-filter.test.ts
// bench CLI 的 --suite 过滤分支单测。
//
// 背景：这层逻辑以前只能靠"真跑一遍 bench"间接验证 —— bench 测试目录里 grep 不到
// parseSuite / --suite 的任何直接断言 ⇒ 过滤分支本身没有单测保护，改坏了只有真跑
// bench 才暴露。
//
// 本文件锁住 5 件事：
//   1. parseSuite：合法值 a|b|all、非法值返回 null（上层据此报错退出）、缺省 all；
//   2. --suite / --repeats 的"值"不会被当成显式 case 名；
//   3. 按 def.suite 过滤（缺省视为 "a"）得到正确子集；
//   4. 显式 case 名优先，但仍受 suite 过滤约束；
//   5. 报告形状：suite A 的结果不含 suite 字段，suite B 的结果含 suite: "b"。

import { describe, it, expect } from "vitest";
import {
  parseSuite,
  parseExplicitCaseNames,
  pickCandidateNames,
  filterBySuite,
  tagSuiteMetric,
  type SuiteFilter,
} from "../src/runner/suite-filter.js";
import { aggregate } from "../src/runner/aggregate.js";
import type { CaseDefinition, CaseMetrics } from "../src/types.js";

/** 假 case：不真跑，只带 name / suite（run 是空壳，从不被调用）。 */
function fakeDef(name: string, suite?: "a" | "b"): CaseDefinition {
  return { name, ...(suite === undefined ? {} : { suite }), run: async () => {} };
}

/** 假指标：形状与 runCase 产出的一致（字段全，不省略）。 */
function fakeMetric(overrides: Partial<CaseMetrics> = {}): CaseMetrics {
  return {
    case: "demo",
    passed: true,
    callCount: 3,
    fallbackToEvaluate: 0,
    observeMissedPopperItems: 0,
    outputBytes: 128,
    durationMs: 42,
    ...overrides,
  };
}

describe("parseSuite", () => {
  it("接受 a / b / all 三个合法值", () => {
    expect(parseSuite(["--suite", "a"])).toBe("a");
    expect(parseSuite(["--suite", "b"])).toBe("b");
    expect(parseSuite(["--suite", "all"])).toBe("all");
  });

  it("非法值返回 null（上层据此报错退出）", () => {
    expect(parseSuite(["--suite", "c"])).toBeNull();
    expect(parseSuite(["--suite", ""])).toBeNull();
    expect(parseSuite(["--suite", "a b"])).toBeNull();
    expect(parseSuite(["--suite", "ab"])).toBeNull();
  });

  it("没有 --suite 时缺省为 all", () => {
    expect(parseSuite([])).toBe("all");
    expect(parseSuite(["--all"])).toBe("all");
    expect(parseSuite(["--repeats", "3"])).toBe("all");
  });

  it("支持 --suite=<v> 写法，值的大小写与首尾空格被规范化", () => {
    expect(parseSuite(["--suite=b"])).toBe("b");
    expect(parseSuite(["--suite=B"])).toBe("b");
    expect(parseSuite(["--suite", " b "])).toBe("b");
    expect(parseSuite(["--suite=A"])).toBe("a");
  });

  it("--suite 没有带值时按缺省处理（all），不是报错", () => {
    expect(parseSuite(["--suite"])).toBe("all");
  });
});

describe("显式 case 名的提取：flag 的值不算 case 名", () => {
  it("--suite b 的 b 不进候选 case 名", () => {
    expect(parseExplicitCaseNames(["--suite", "b"])).toEqual([]);
    expect(parseExplicitCaseNames(["--suite", "b", "el-dropdown"])).toEqual(["el-dropdown"]);
    expect(parseExplicitCaseNames(["--suite=b"])).toEqual([]);
  });

  it("--repeats 3 的 3 不进候选 case 名", () => {
    expect(parseExplicitCaseNames(["--repeats", "3"])).toEqual([]);
    expect(parseExplicitCaseNames(["--repeats", "3", "el-dropdown"])).toEqual(["el-dropdown"]);
    expect(parseExplicitCaseNames(["--repeats=3"])).toEqual([]);
  });

  it("--suite b + --repeats 3 同时在时，两个值都不进候选 case 名", () => {
    expect(parseExplicitCaseNames(["--suite", "b", "--repeats", "3"])).toEqual([]);
    expect(parseExplicitCaseNames(["--suite", "b", "--repeats", "3", "el-dropdown"])).toEqual([
      "el-dropdown",
    ]);
  });

  it("候选名单来自 cases/ 目录，不会把 flag 的值当成 case", async () => {
    const allNames = ["el-dropdown", "contract/overlay-pinned"];
    const names = await pickCandidateNames(
      ["--suite", "b"],
      { runAll: false, suite: "b" },
      async () => allNames,
    );
    expect(names).toEqual(["el-dropdown", "contract/overlay-pinned"]);
    expect(names).not.toContain("b");
  });
});

describe("按 suite 过滤 case", () => {
  // "legacy-no-suite" 故意不写 suite 字段 —— 缺省视为 "a"
  const defs = [
    fakeDef("el-dropdown", "a"),
    fakeDef("legacy-no-suite"),
    fakeDef("contract/overlay-pinned", "b"),
  ];

  it("--suite a 选出 suite a 与缺省 suite 的 case", () => {
    expect(filterBySuite(defs, "a").map((d) => d.name)).toEqual([
      "el-dropdown",
      "legacy-no-suite",
    ]);
  });

  it("--suite b 只选出显式标 b 的 case", () => {
    expect(filterBySuite(defs, "b").map((d) => d.name)).toEqual(["contract/overlay-pinned"]);
  });

  it("--suite all 不筛掉任何 case", () => {
    expect(filterBySuite(defs, "all").map((d) => d.name)).toEqual([
      "el-dropdown",
      "legacy-no-suite",
      "contract/overlay-pinned",
    ]);
  });

  it("suite 缺省的 case 不会被 --suite b 选中", () => {
    expect(filterBySuite(defs, "b").map((d) => d.name)).not.toContain("legacy-no-suite");
  });
});

describe("显式 case 名与 --suite 的交互", () => {
  const defs = [fakeDef("el-dropdown", "a"), fakeDef("contract/overlay-pinned", "b")];
  const byName = new Map(defs.map((d) => [d.name, d]));

  /** 复刻 cmdRun 的两段式选择：先选候选名 → 加载 def → 再按 suite 过滤。 */
  async function select(args: string[], suite: SuiteFilter): Promise<string[]> {
    const names = await pickCandidateNames(
      args,
      { runAll: false, suite },
      async () => [...byName.keys()],
    );
    return filterBySuite(
      names.map((n) => byName.get(n)!),
      suite,
    ).map((d) => d.name);
  }

  it("显式名优先：不给 --suite 时只跑显式点名的那一个", async () => {
    expect(await select(["el-dropdown"], "all")).toEqual(["el-dropdown"]);
  });

  it("显式名仍受 suite 约束：显式点名 suite A 的 case + --suite b ⇒ 选不出来", async () => {
    expect(await select(["el-dropdown", "--suite", "b"], "b")).toEqual([]);
  });

  it("显式名仍受 suite 约束：显式点名 suite B 的 case + --suite a ⇒ 选不出来", async () => {
    expect(await select(["contract/overlay-pinned", "--suite", "a"], "a")).toEqual([]);
  });

  it("显式名与 --suite 一致时选中该 case", async () => {
    expect(await select(["contract/overlay-pinned", "--suite", "b"], "b")).toEqual([
      "contract/overlay-pinned",
    ]);
    expect(await select(["el-dropdown", "--suite", "a"], "a")).toEqual(["el-dropdown"]);
  });

  it("显式名 + --suite all 时选中该 case", async () => {
    expect(await select(["contract/overlay-pinned", "--suite", "all"], "all")).toEqual([
      "contract/overlay-pinned",
    ]);
  });
});

describe("报告里的 suite 字段", () => {
  it("suite A 的结果不含 suite 字段，序列化逐字节不变", () => {
    const m = fakeMetric();
    const before = JSON.stringify(m);
    const tagged = tagSuiteMetric(m, "a");
    expect(tagged.suite).toBeUndefined();
    expect("suite" in tagged).toBe(false);
    expect(JSON.stringify(tagged)).toBe(before);
    expect(JSON.stringify(tagged)).not.toContain('"suite"');
  });

  it("suite B 的结果含 suite: \"b\"", () => {
    const tagged = tagSuiteMetric(fakeMetric(), "b");
    expect(tagged.suite).toBe("b");
    expect(JSON.parse(JSON.stringify(tagged)).suite).toBe("b");
  });

  it("aggregate() 多 run 路径丢掉 suite 透传字段 ⇒ suite B 的字段只能靠事后补写", () => {
    const agg = aggregate([fakeMetric({ suite: "b" }), fakeMetric({ suite: "b" })]);
    expect("suite" in agg).toBe(false);
    expect(tagSuiteMetric(agg, "b").suite).toBe("b");
  });
});
