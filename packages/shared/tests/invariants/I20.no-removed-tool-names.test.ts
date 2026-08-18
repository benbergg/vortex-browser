// I20: hint 不引用 v0.5 已删工具名（regression grep）
// spec: vortex重构-L5-spec.md §1.4
//
// v0.6 LLM 只看到 11 公开工具；hint 引用任何不在白名单的 vortex_* 名字 = 误导
// LLM 调一个 tools/list 拿不到的工具。
//
// 白名单 = v0.6 公开 11 工具（与 schemas-public.ts PUBLIC_TOOLS 对齐）

import { describe, it, expect } from "vitest";
import { DEFAULT_ERROR_META, OVERRIDE_HINTS } from "../../src/errors.hints.js";

const PUBLIC_TOOL_NAMES = new Set([
  "vortex_act",
  "vortex_observe",
  "vortex_extract",
  "vortex_navigate",
  "vortex_tab_create",
  "vortex_tab_close",
  "vortex_screenshot",
  "vortex_wait_for",
  "vortex_press",
  "vortex_debug_read",
  "vortex_storage",
]);

const TOOL_NAME_RE = /vortex_[a-z][a-z_0-9]*/g;

// override hint(vtxError 第 4 参)同样直达 LLM,必须一起扫。
const ALL_HINTS: Array<[string, string]> = [
  ...Object.entries(DEFAULT_ERROR_META).map(([code, meta]): [string, string] => [code, meta.hint]),
  ...Object.entries(OVERRIDE_HINTS),
];

describe("I20: hint 引用工具名必须是公开 11 之一", () => {
  for (const [code, hint] of ALL_HINTS) {
    it(`${code} hint 不含 v0.5 已删 / 内部化工具名`, () => {
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
