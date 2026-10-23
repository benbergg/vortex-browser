// 契约护栏：谁删掉关键限制说明 / 谁改坏逐字串，谁红。
//
// 评审 Important #1：只搜整个 schema 序列化结果等于没锁——既有英文说明里已经
//  含有 {start,end} / Lake Sheet / [VORTEX_TRUNCATED] / statusMin，删掉新增的
//  中文限制说明，弱断言照样绿。⇒ 改成在**具体参数的 description 字段**上
//  断言本次新增的关键限制语句（PROTECTED_PARAM_CLAUSES）。
//
// 评审 Important #2：单一真值里的逐字串与哨兵格式没被锁——把 mustInclude 改成
//  "x"、或删掉哨兵的括号/空格，旧断言仍可能过。⇒ 10 条 mustInclude 在本文件
//  里硬编码后逐字比对（刻意的重复 = 锁的实现方式），哨兵改用 toBe 精确相等。
//
// 方向不可反：contract.ts 是单一真值，不从本测试导入任何值。

import { describe, expect, it } from "vitest";
import {
  CONTRACT_ITEMS,
  INSTRUCTIONS_TOKEN_BUDGET,
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  estimateTokens,
} from "../src/contract.js";
import { PUBLIC_TOOL_NAMES } from "@vortex-browser/shared";
import { getToolDefs } from "../src/tools/registry.js";

/**
 * 10 条契约要点的逐字必须串（硬编码在本测试里 = 刻意的重复 = 锁）。
 * 改动 contract.ts 的串而不同步这里 ⇒ 必红。
 */
const EXPECTED_MUST_INCLUDE: Record<string, string[]> = {
  workflow: ["vortex_observe"],
  "ref-lifecycle": ["@<hash>:eN"],
  "fill-value-shape": ["{start,end}"],
  "query-mode-boundary": ["Lake Sheet"],
  "wait-for-modes": ["mode=info"],
  "screenshot-target": ["CSS selector"],
  "extract-truncation": ["[VORTEX_TRUNCATED]"],
  "debug-read-params": ["statusMin"],
  "effect-signals": ["urlChanged"],
  "path-case": ["/#/el-cascader"],
};

/**
 * 受保护参数：工具 → 参数 → 本次新增的关键限制语句 + 语句内不可再拆的限制片段。
 *
 * - `key`：contract.ts 里的契约要点 key，用于把该参数的 description 与契约清单
 *   的逐字串绑在一起（两侧同源，改一侧不同步另一侧即红）。
 * - `clause`：参数 description 必须逐字包含的整句限制说明。
 * - `fragments`：clause 内部的关键限制片段，逐个断言。用来堵住"只留关键词、
 *   把限制本身删掉"的漏法（例如只留 `Lake Sheet` 却删掉"不认普通 DOM table"）。
 */
const PROTECTED_PARAM_CLAUSES: Array<{
  key: string;
  tool: string;
  param: string;
  clause: string;
  fragments: string[];
}> = [
  {
    key: "fill-value-shape",
    tool: "vortex_fill",
    param: "value",
    clause: "按 widget 形状取值；daterange 需 {start,end}",
    fragments: ["按 widget 形状取值", "daterange 需 {start,end}"],
  },
  {
    key: "query-mode-boundary",
    tool: "vortex_query",
    param: "mode",
    clause: "sheet 只认 Lake Sheet，不认普通 DOM table；component 返回 Vue 实例/props，selector 仍是 CSS",
    fragments: ["不认普通 DOM table", "component 返回 Vue 实例/props", "selector 仍是 CSS"],
  },
  {
    key: "extract-truncation",
    tool: "vortex_extract",
    param: "maxLength",
    clause: "超长会截断并带 [VORTEX_TRUNCATED] 标记",
    fragments: ["超长会截断并带", "[VORTEX_TRUNCATED] 标记"],
  },
  {
    key: "debug-read-params",
    tool: "vortex_debug_read",
    param: "filter",
    clause: "statusMin 配合 statusMax 过滤 HTTP 状态码区间",
    fragments: ["statusMin", "配合 statusMax 过滤 HTTP 状态码区间"],
  },
];

/** 取某个工具某个具体参数的 description（取不到即失败，不返回空串蒙混）。 */
function getParamDescription(tool: string, param: string): string {
  const def = getToolDefs().find((d) => d.name === tool);
  expect(def, `工具 ${tool} 不在公开面里`).toBeDefined();
  const props = (def!.schema as { properties?: Record<string, { description?: string }> }).properties;
  expect(props, `${tool} 没有 properties`).toBeDefined();
  const prop = props![param];
  expect(prop, `${tool} 没有参数 ${param}`).toBeDefined();
  expect(prop!.description, `${tool}.${param} 没有 description`).toBeDefined();
  return prop!.description!;
}

describe("契约护栏", () => {
  it("契约清单覆盖设计稿的 10 条要点", () => {
    expect(CONTRACT_ITEMS.map((i) => i.key)).toEqual([
      "workflow",
      "ref-lifecycle",
      "fill-value-shape",
      "query-mode-boundary",
      "wait-for-modes",
      "screenshot-target",
      "extract-truncation",
      "debug-read-params",
      "effect-signals",
      "path-case",
    ]);
  });

  it("每条契约都带至少一条逐字必须串", () => {
    for (const item of CONTRACT_ITEMS) {
      expect(item.mustInclude.length, item.key).toBeGreaterThan(0);
      for (const s of item.mustInclude) expect(s.length).toBeGreaterThan(0);
    }
  });

  it("10 条要点的逐字必须串被逐字锁死（改 contract.ts 的串即红）", () => {
    const actual: Record<string, string[]> = {};
    for (const item of CONTRACT_ITEMS) actual[item.key] = [...item.mustInclude];
    expect(actual).toEqual(EXPECTED_MUST_INCLUDE);
    // 逐条再比一次，失败时能直接看出是哪一条的哪个串坏了
    for (const [key, expected] of Object.entries(EXPECTED_MUST_INCLUDE)) {
      const item = CONTRACT_ITEMS.find((i) => i.key === key);
      expect(item, `契约清单缺 key=${key}`).toBeDefined();
      expect([...item!.mustInclude], `key=${key} 的逐字必须串变了`).toEqual(expected);
    }
  });

  it("体积预算常量是 1200 tokens", () => {
    expect(INSTRUCTIONS_TOKEN_BUDGET).toBe(1200);
  });

  it("哨兵常量是精确字符串（删括号/空格/前缀即红）", () => {
    expect(SENTINEL_PREFIX).toBe("[vortex:instructions] ");
    expect(SENTINEL_SUFFIX).toBe("[vortex:instructions] end ");
  });

  it("估算函数对中英文分别计费", () => {
    expect(estimateTokens("中文字")).toBe(3);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("公开工具名未被改动（冻结契约）", () => {
    expect(PUBLIC_TOOL_NAMES.size).toBe(24);
  });

  it("受保护参数的 description 含关键限制语句（删任一句即红）", () => {
    for (const guard of PROTECTED_PARAM_CLAUSES) {
      const desc = getParamDescription(guard.tool, guard.param);
      expect(
        desc,
        `${guard.tool}.${guard.param} 缺少关键限制语句「${guard.clause}」`,
      ).toContain(guard.clause);
      for (const fragment of guard.fragments) {
        expect(
          desc,
          `${guard.tool}.${guard.param} 缺少限制片段「${fragment}」`,
        ).toContain(fragment);
      }
    }
  });

  it("契约逐字串落在对应受保护参数的 description 里（契约与工具面同源）", () => {
    for (const guard of PROTECTED_PARAM_CLAUSES) {
      const item = CONTRACT_ITEMS.find((i) => i.key === guard.key);
      expect(item, `契约清单缺 key=${guard.key}`).toBeDefined();
      const desc = getParamDescription(guard.tool, guard.param);
      for (const needle of item!.mustInclude) {
        expect(
          desc,
          `${guard.tool}.${guard.param} 未携带契约串 ${needle}（key=${guard.key}）`,
        ).toContain(needle);
      }
    }
  });
});
