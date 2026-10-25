// I21: agent 可见的 hint 不得指向 agent 永远收不到的字段
// spec: docs/superpowers/plans/2026-10-25-extract-preload-guard.md（Review Focus 3 / Task 2）
//
// 为什么需要这条不变量（源码级依据，不是推测）：
// - `context` 只存在于 `VtxErrorPayload`（packages/shared/src/protocol.ts:116-122），
//   即错误在扩展侧被序列化时才带得上；
// - MCP 的两个渲染出口都**不输出 context**：
//   · `packages/mcp/src/lib/dispatch-error.ts:13-32` → `Error [CODE]: message` + `Hint: hint`
//   · `packages/mcp/src/server.ts:81-87`（formatError）→ 同上
//   （formatDispatchError 唯一特殊读取的 `context.extras.lastReason` 也只用于追加一条
//    TIMEOUT hint，不会把 extras 序列化进给 agent 的文本）
// ⇒ agent 实测只拿到两行：`Error [CODE]: message` 与 `Hint: <hint>`。
// 所以任何「去看 context.extras / context.<field>」的文案都是死路：它把 agent 送去
// 一个它拿不到的字段（7 天日志里 2 次 JS_EXECUTION_ERROR 就是这么空转的）。
//
// 契约：DEFAULT_ERROR_META（每个错误码的默认 hint）+ OVERRIDE_HINTS（经 vtxError
// 第 4 参下发的场景化 hint）里的每一条，都不得出现 `context.extras` 或任何
// `context.<field>` 形式的字段引用。

import { describe, it, expect } from "vitest";
import {
  DEFAULT_ERROR_META,
  OVERRIDE_HINTS,
  PAGE_NOT_READY_INJECT_HINT,
} from "../../src/errors.hints.js";
import { PUBLIC_TOOL_NAMES } from "../../src/public-tools.js";

/** 悬空的 context 字段引用：`context.extras` 是最典型的一例，泛化到任何 `context.<字段>`。 */
const DANGLING_CONTEXT_REF = /context\.[a-z_]/i;

/** I19 同款 next-action 动词表（hint 必须给出 LLM 该做的下一步）。 */
const ACTION_VERBS =
  /\b(call|use|verify|check|retry|wait|set|inspect|switch|increase|dismiss|handle|pick|complete|close|select|fall ?back|rewrite|reload|enable|grant|fix|adjust|narrow|add|expose|capture|operate|ensure|fill|satisfy|bring|descend|configure|install|reattach)\b/i;

const TOOL_NAME_RE = /vortex_[a-z][a-z_0-9]*/g;

const HINT_MIN = 50;
const HINT_MAX = 300;

/**
 * 扫描面 = 默认 hint 全表 + 经 vtxError 第 4 参下发的 override hint。
 * 两者都直达 LLM，同受本契约约束（同 I19/I20 的扫描面口径）。
 */
const ALL_HINTS: Array<[string, string]> = [
  ...Object.entries(DEFAULT_ERROR_META).map(([code, meta]): [string, string] => [code, meta.hint]),
  ...Object.entries(OVERRIDE_HINTS),
];

describe("I21: agent 可见 hint 不引用收不到的 context 字段", () => {
  for (const [code, hint] of ALL_HINTS) {
    it(`${code} hint 不含 context.extras`, () => {
      expect(
        hint,
        `${code} hint 让 agent 去查 context.extras，但 MCP 渲染层只输出 message + hint: "${hint}"`,
      ).not.toMatch(/context\.extras/);
    });

    it(`${code} hint 不含任何 context.<字段> 引用`, () => {
      expect(
        hint,
        `${code} hint 让 agent 去查 context 里的字段，而该字段不会被渲染给 agent: "${hint}"`,
      ).not.toMatch(DANGLING_CONTEXT_REF);
    });
  }

  // 命中数断言：扫描面塌成空集 / 漏掉 override 常量时本条先红，避免空集假绿
  it("扫描面覆盖 DEFAULT_ERROR_META + OVERRIDE_HINTS 且非空", () => {
    expect(ALL_HINTS.length).toBe(
      Object.keys(DEFAULT_ERROR_META).length + Object.keys(OVERRIDE_HINTS).length,
    );
    expect(Object.keys(DEFAULT_ERROR_META).length).toBeGreaterThan(0);
    expect(Object.keys(OVERRIDE_HINTS).length).toBeGreaterThan(0);
  });
});

describe("I21: PAGE_NOT_READY_INJECT_HINT 合同", () => {
  it("是导出的非空字符串", () => {
    expect(typeof PAGE_NOT_READY_INJECT_HINT).toBe("string");
    expect(PAGE_NOT_READY_INJECT_HINT.length).toBeGreaterThan(0);
  });

  it(`长度在 [${HINT_MIN}, ${HINT_MAX}]`, () => {
    expect(
      PAGE_NOT_READY_INJECT_HINT.length,
      `length=${PAGE_NOT_READY_INJECT_HINT.length}: "${PAGE_NOT_READY_INJECT_HINT}"`,
    ).toBeGreaterThanOrEqual(HINT_MIN);
    expect(PAGE_NOT_READY_INJECT_HINT.length).toBeLessThanOrEqual(HINT_MAX);
  });

  it("含 next-action 动词", () => {
    expect(PAGE_NOT_READY_INJECT_HINT).toMatch(ACTION_VERBS);
  });

  it("引用的工具名全在 PUBLIC_TOOL_NAMES 内", () => {
    const names = PAGE_NOT_READY_INJECT_HINT.match(TOOL_NAME_RE) ?? [];
    expect(names.length).toBeGreaterThan(0);
    const unknown = names.filter((n) => !PUBLIC_TOOL_NAMES.has(n));
    expect(unknown, `引用了未公开工具: ${JSON.stringify(unknown)}`).toEqual([]);
  });

  // 单一真源：常量必须登记进 OVERRIDE_HINTS，否则它绕过 I19/I20 的 hint 质量契约
  it("已登记进 OVERRIDE_HINTS（受 I19/I20 扫描）", () => {
    // 先断言键存在：否则两侧同为 undefined 时 toBe 会假绿
    expect(Object.keys(OVERRIDE_HINTS)).toContain("PAGE_NOT_READY_INJECT_HINT");
    expect(OVERRIDE_HINTS.PAGE_NOT_READY_INJECT_HINT).toBe(PAGE_NOT_READY_INJECT_HINT);
  });

  it("不含 context.extras 悬空引用", () => {
    expect(PAGE_NOT_READY_INJECT_HINT).not.toMatch(/context\.extras/);
    expect(PAGE_NOT_READY_INJECT_HINT).not.toMatch(DANGLING_CONTEXT_REF);
  });
});
