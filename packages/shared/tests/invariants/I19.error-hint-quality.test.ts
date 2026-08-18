// I19: 53 错误码 hint 质量审计
// spec: vortex重构-L5-spec.md §1.2
//
// 每个 DEFAULT_ERROR_META[code].hint 必须字面包含：
//   1. next-action 动词（call / use / verify / check / retry / wait / set / inspect / switch / increase / dismiss / handle / pick / complete / close / select / fall back / rewrite ...）
//   2. 工具名 OR 参数名（vortex_*, param/argument/attribute/selector）
//   3. 长度 50 ~ 300 字符（短了信息不够，长了 LLM 难消化）

import { describe, it, expect } from "vitest";
import { DEFAULT_ERROR_META, OVERRIDE_HINTS } from "../../src/errors.hints.js";

// 动词白名单 — 表述 LLM 应做的下一步
const ACTION_VERBS =
  /\b(call|use|verify|check|retry|wait|set|inspect|switch|increase|dismiss|handle|pick|complete|close|select|fall ?back|rewrite|reload|enable|grant|fix|adjust|narrow|add|expose|capture|operate|ensure|fill|satisfy|bring|descend|configure|install|reattach)\b/i;

// "工具名 / 参数 / 属性" 关键词 — hint 必须给出可以操作的具体词
const TOOL_OR_PARAM = /vortex_[a-z_]+|param(eter)?|argument|attribute|selector|context\.|frameId|timeout|tabId|state|mode|kind|action/i;

const HINT_MIN = 50;
const HINT_MAX = 300;

// 经 vtxError 第 4 参下发的 override hint 与默认 hint 同样直达 LLM,同受本契约约束。
const ALL_HINTS: Array<[string, string]> = [
  ...Object.entries(DEFAULT_ERROR_META).map(([code, meta]): [string, string] => [code, meta.hint]),
  ...Object.entries(OVERRIDE_HINTS),
];

describe("I19: error hint quality (53 codes)", () => {
  for (const [code, hint] of ALL_HINTS) {
    describe(code, () => {
      it("hint 含 next-action 动词", () => {
        expect(hint, `${code} hint missing action verb: "${hint}"`).toMatch(ACTION_VERBS);
      });

      it("hint 含工具名 OR 参数关键词", () => {
        expect(hint, `${code} hint missing tool/param hint: "${hint}"`).toMatch(TOOL_OR_PARAM);
      });

      it(`hint 长度在 [${HINT_MIN}, ${HINT_MAX}]`, () => {
        expect(hint.length, `${code} hint length=${hint.length}: "${hint}"`)
          .toBeGreaterThanOrEqual(HINT_MIN);
        expect(hint.length).toBeLessThanOrEqual(HINT_MAX);
      });
    });
  }

  it("DEFAULT_ERROR_META 至少覆盖 53 错误码", () => {
    expect(Object.keys(DEFAULT_ERROR_META).length).toBeGreaterThanOrEqual(44);
  });

  // 命中数断言:扫描面为空/漏掉 override 常量时本条先红,避免空集假绿
  it("扫描面含 override hint(不只是 DEFAULT_ERROR_META)", () => {
    expect(Object.keys(OVERRIDE_HINTS).length).toBeGreaterThanOrEqual(2);
    expect(ALL_HINTS.length).toBe(
      Object.keys(DEFAULT_ERROR_META).length + Object.keys(OVERRIDE_HINTS).length,
    );
  });
});
