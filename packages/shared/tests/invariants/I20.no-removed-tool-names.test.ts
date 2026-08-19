// I20: hint 不引用未公开的工具名（regression grep）
// spec: vortex重构-L5-spec.md §1.4
//
// LLM 的 tools/list 只看得到 schemas-public.ts 暴露的那些工具；hint 引用任何不在
// 其中的 vortex_* 名字 = 指引 LLM 去调一个它拿不到的工具。
//
// 白名单取自 shared 的 PUBLIC_TOOL_NAMES 单一真源。本文件曾手抄一份并冻结在
// v0.6 的 11 个，结果反过来把 hint 逼差（2026-08-19）：正确指引被判红。
// 真源与 schemas-public.ts 的漂移由 packages/mcp 的用例锁住。

import { describe, it, expect } from "vitest";
import { DEFAULT_ERROR_META, OVERRIDE_HINTS } from "../../src/errors.hints.js";
import { PUBLIC_TOOL_NAMES } from "../../src/public-tools.js";

const TOOL_NAME_RE = /vortex_[a-z][a-z_0-9]*/g;

// override hint(vtxError 第 4 参)同样直达 LLM,必须一起扫。
const ALL_HINTS: Array<[string, string]> = [
  ...Object.entries(DEFAULT_ERROR_META).map(([code, meta]): [string, string] => [code, meta.hint]),
  ...Object.entries(OVERRIDE_HINTS),
];

describe("I20: hint 引用工具名必须是公开工具之一", () => {
  for (const [code, hint] of ALL_HINTS) {
    it(`${code} hint 不含未公开 / 内部化工具名`, () => {
      const matches = hint.match(TOOL_NAME_RE) ?? [];
      const removed = matches.filter((name) => !PUBLIC_TOOL_NAMES.has(name));
      expect(
        removed,
        `${code} hint references removed/internal tool(s): ${JSON.stringify(removed)}\nhint: "${hint}"`,
      ).toEqual([]);
    });
  }

  // 命中数断言:扫描面塌成空集或漏掉 override 常量时先红
  it("扫描面覆盖 DEFAULT_ERROR_META + override hint 且至少引用过一次工具名", () => {
    expect(Object.keys(OVERRIDE_HINTS).length).toBeGreaterThanOrEqual(2);
    expect(ALL_HINTS.length).toBe(
      Object.keys(DEFAULT_ERROR_META).length + Object.keys(OVERRIDE_HINTS).length,
    );
    const withTool = ALL_HINTS.filter(([, h]) => (h.match(TOOL_NAME_RE) ?? []).length > 0);
    expect(withTool.length).toBeGreaterThan(0);
  });
});
