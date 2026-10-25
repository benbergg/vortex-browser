// I21: agent 可见的 hint 不得指向调用方读不到的字段
// spec: docs/superpowers/plans/2026-10-25-extract-preload-guard.md（Review Focus 3 / Task 2）
// 复核: /tmp/vortex-analysis/review-impl-2-codex.md（R1 / R2 / R6）
//
// 为什么需要这条不变量（源码级依据，不是推测）：
// - `context` 只存在于 `VtxErrorPayload`（**packages/shared/src/errors.ts:116-122**，不是
//   protocol.ts），即错误在扩展侧被序列化时才带得上；
// - **经当前 MCP 错误文本渲染的调用者**读不到它：
//   · packages/mcp/src/lib/dispatch-error.ts:13-32 → `Error [CODE]: message` + `Hint: hint`
//   · packages/mcp/src/server.ts:81-87（formatError）→ 同上
//   （formatDispatchError 唯一特殊读取的 `context.extras.lastReason` 也只用于追加一条
//    TIMEOUT hint，不会把 extras 序列化进给 agent 的文本）
// - 限定范围（别把话说过头）：CLI（packages/cli/src/client.ts:85-93）会渲染 context JSON，
//   hub/内部结构化消费者也读得到 ⇒ 本不变量针对的是「经 MCP 错误文本渲染的调用者」，
//   **不是**「所有消费者」。payload 本身照旧保留，删的只是指向它的死路文案。
//
// 三层扫描：
//   1) 两张表：DEFAULT_ERROR_META + OVERRIDE_HINTS（运行期枚举，不是源码正则）；
//   2) 内联 hint 字面量源码扫描：extension / mcp / hub 的 src/**（source-lock 正则风格，
//      沿用 packages/extension/tests/content-extract-shadow-text.test.ts 的做法）；
//   3) 规则自测：代表性禁用样本必须被命中、代表性干净样本不得被误报——
//      避免"正则不命中"被误当成"没有悬空指引"。
//
// 已知边界（诚实声明）：第 2 层是正则扫描，只能覆盖 `hint:` / `hintOverride` 后**直接跟字面量**
// 的写法；hint 经变量中转再传进 vtxError 的形态扫不到（codex 用 TS AST 全量枚举过，
// 结论是当前仓库没有剩余的悬空内联 hint，但那是**一次性人工核对**，不是本测试的保证）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DEFAULT_ERROR_META,
  OVERRIDE_HINTS,
  PAGE_NOT_READY_INJECT_HINT,
} from "../../src/errors.hints.js";
import { PUBLIC_TOOL_NAMES } from "../../src/public-tools.js";

/**
 * 禁用规则：把调用方指向「读不到的字段」的措辞。
 * 每条都对应一个真实出现过的死路写法（见规则自测里的代表性样本）。
 */
interface ForbiddenRule {
  /** 稳定 id：测试样本用它断言命中了哪条规则（显示名会随文案调整，id 不动） */
  id: string;
  /** 给人看的规则说明 */
  name: string;
  re: RegExp;
}

const FORBIDDEN_RULES: ForbiddenRule[] = [
  { id: "context.extras", name: "context.extras", re: /context\s*\.\s*extras/i },
  { id: "context.field", name: "context.<字段>", re: /context\s*\.\s*[a-z_]/i },
  { id: "extras.field", name: "extras.<字段>", re: /\bextras\s*\.\s*[a-z_]/i },
  { id: "lastReason", name: "lastReason", re: /lastReason/i },
  {
    id: "context.generic",
    name: "泛指 context(see/inspect/read/check the context)",
    re: /\b(?:see|inspect|read|check|consult)\s+(?:at\s+|up\s+)?(?:the\s+|this\s+)?context\b/i,
  },
  {
    id: "context.in-from",
    name: "in/from the context",
    re: /\b(?:in|from|inside|within|via)\s+the\s+context\b/i,
  },
  {
    id: "context.may-carry",
    name: "context may carry",
    re: /\bcontext\s+(?:may|might|could|can)\s+(?:carry|contain|hold|include|have)\b/i,
  },
];

/** 命中即报规则 id；空数组 = 通过。 */
function forbiddenHits(text: string): string[] {
  return FORBIDDEN_RULES.filter((r) => r.re.test(text)).map((r) => r.id);
}

/** 把规则 id 翻成可读说明，给断言消息用。 */
function describeHits(ids: string[]): string {
  return ids
    .map((id) => FORBIDDEN_RULES.find((r) => r.id === id)?.name ?? id)
    .join(", ");
}

/** I19 同款 next-action 动词表（hint 必须给出 LLM 该做的下一步）。 */
const ACTION_VERBS =
  /\b(call|use|verify|check|retry|wait|set|inspect|switch|increase|dismiss|handle|pick|complete|close|select|fall ?back|rewrite|reload|enable|grant|fix|adjust|narrow|add|expose|capture|operate|ensure|fill|satisfy|bring|descend|configure|install|reattach)\b/i;

const TOOL_NAME_RE = /vortex_[a-z][a-z_0-9]*/g;

const HINT_MIN = 50;
const HINT_MAX = 300;

/**
 * 扫描面 = 默认 hint 全表 + 经 vtxError 第 4 参下发的 override hint。
 * 两者都直达调用方，同受本契约约束（同 I19/I20 的扫描面口径）。
 */
const ALL_HINTS: Array<[string, string]> = [
  ...Object.entries(DEFAULT_ERROR_META).map(([code, meta]): [string, string] => [code, meta.hint]),
  ...Object.entries(OVERRIDE_HINTS),
];

describe("I21: 两张表内不得出现指向不可见字段的措辞", () => {
  for (const [code, hint] of ALL_HINTS) {
    it(`${code} hint 是非空字符串且无悬空字段引用`, () => {
      expect(typeof hint, `${code} hint 不是字符串`).toBe("string");
      expect(hint.length, `${code} hint 是空串`).toBeGreaterThan(0);
      const hits = forbiddenHits(hint);
      expect(
        hits,
        `${code} hint 把调用方指向读不到的字段(${describeHits(hits)})：` +
          `经 MCP 错误文本渲染的调用者只拿到 message + hint：` +
          `"${hint}"`,
      ).toEqual([]);
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

describe("I21: 禁用规则自测（正则本身也要被测）", () => {
  // 这些是真实出现过的死路写法（逐条取自本仓库历史文案），必须被命中
  const FORBIDDEN_SAMPLES: Array<[string, string]> = [
    [
      "Inspect the error message in context.extras and adjust the selector or action arguments before retrying.",
      "context.extras",
    ],
    [
      "Unexpected error in the vortex runtime (server / mcp). Inspect context.extras for the underlying message and retry.",
      "context.extras",
    ],
    [
      "Commit driver failed mid-flow. Inspect context.extras.stage (open-picker / navigate-month) to see which step broke.",
      "context.extras",
    ],
    [
      "All fallback paths exhausted. context.extras.attemptedPaths lists what was tried.",
      "context.extras",
    ],
    [
      "The select value matched no <option>. Read the available options (listed in context.extras.available) and retry.",
      "context.extras",
    ],
    [
      "Navigation failed. Verify the url argument and retry; the context may carry the underlying browser error.",
      "context.may-carry",
    ],
    ["Inspect the context for the underlying reason.", "context.generic"],
    ["see the context for details", "context.generic"],
    ["the lastReason field says which step broke", "lastReason"],
    ["extras.available lists the options", "extras.field"],
  ];

  for (const [sample, expectedRule] of FORBIDDEN_SAMPLES) {
    it(`禁用样本被命中: ${JSON.stringify(sample.slice(0, 48))}`, () => {
      const hits = forbiddenHits(sample);
      expect(hits.length, `样本未被任何规则命中: "${sample}"`).toBeGreaterThan(0);
      expect(hits, `样本未命中预期规则 ${expectedRule}: "${sample}"`).toContain(expectedRule);
    });
  }

  // 干净样本不得被误报（正则过宽会把正确文案逼坏——I20 曾因手抄白名单倒逼 hint 变差）
  const CLEAN_SAMPLES: string[] = [
    "Element hit-test failed; another element covers it (the covering element is named in the message).",
    // 「its own tab context」指浏览器执行上下文，不是错误字段指引
    "operate within the iframe via its own tab context",
    "Call vortex_observe to re-read the page state, then try a different approach.",
    "Check the error text: if it reports a framework-controlled component and names a tool, use it.",
  ];

  for (const sample of CLEAN_SAMPLES) {
    it(`干净样本不被误报: ${JSON.stringify(sample.slice(0, 48))}`, () => {
      expect(forbiddenHits(sample), `干净样本被误报: "${sample}"`).toEqual([]);
    });
  }
});

describe("I21: 内联 hint 字面量源码扫描", () => {
  /** 被扫描的源码根目录（相对本测试文件）。 */
  const SRC_ROOTS = ["../../../extension/src", "../../../mcp/src", "../../../hub/src"];

  /** `hint:` / `hintOverride` 后**直接跟字符串字面量**（可多段拼接）的写法。 */
  const HINT_LITERAL_RE =
    /\bhint(?:Override)?\b\s*[:=]\s*((?:"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)(?:\s*\+\s*(?:"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`))*)/g;

  function walkTs(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walkTs(p, out);
      else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  function literalText(raw: string): string {
    return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|`([^`]*)`/g)]
      .map((m) => m[1] ?? m[2] ?? "")
      .join("");
  }

  interface InlineHit {
    file: string;
    line: number;
    text: string;
  }

  const inlineHits: InlineHit[] = [];
  const scannedFiles: string[] = [];
  for (const root of SRC_ROOTS) {
    const abs = fileURLToPath(new URL(root, import.meta.url));
    const files = walkTs(abs);
    scannedFiles.push(...files);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(HINT_LITERAL_RE)) {
        inlineHits.push({
          file,
          line: src.slice(0, m.index).split("\n").length,
          text: literalText(m[1]),
        });
      }
    }
  }

  it("扫描面非空（防路径写错 / 规则空转导致的假绿）", () => {
    expect(scannedFiles.length, "没扫到任何源文件，扫描根路径可能写错").toBeGreaterThan(100);
    expect(inlineHits.length, "没扫到任何内联 hint 字面量，规则可能空转").toBeGreaterThan(10);
  });

  it("三个包各自都扫到内联 hint（防止某个包路径写错而被静默跳过）", () => {
    for (const root of SRC_ROOTS) {
      const abs = fileURLToPath(new URL(root, import.meta.url));
      const inThisRoot = inlineHits.filter((h) => h.file.startsWith(abs));
      expect(inThisRoot.length, `${root} 下没扫到内联 hint 字面量`).toBeGreaterThan(0);
    }
  });

  for (const hit of inlineHits) {
    it(`内联 hint 无悬空字段引用: ${hit.file.split("/").pop()}:${hit.line}`, () => {
      const hits = forbiddenHits(hit.text);
      expect(
        hits,
        `${hit.file}:${hit.line} 内联 hint 把调用方指向读不到的字段(${describeHits(hits)})：` +
          `"${hit.text}"`,
      ).toEqual([]);
    });
  }
});

describe("I21: hint 不得对错误原文做无条件承诺", () => {
  // 反例来源（codex 复核 R1）：
  // UNSUPPORTED_TARGET 的 message **不总是**说明实际命中对象——
  // extension/src/page-side/commit-drivers/select.ts:94-96 与 checkbox-group.ts:55-57 只说
  // "Target does not match driver closestSelector ..."，给的是**期望的** driver selector；
  // 且 select.ts:89-91 与 handlers/dom.ts:1076-1078 的实际目标是 **native select**，
  // 与"框架组件"无关。故 hint 不得无条件断言是框架组件，也不得承诺 message 的内容。
  it("UNSUPPORTED_TARGET hint 不承诺 message 内容，也不无条件断言是框架组件", () => {
    const hint = DEFAULT_ERROR_META.UNSUPPORTED_TARGET.hint;
    expect(hint).not.toMatch(/the message above (says|shows|names|carries|contains)/i);
    expect(hint).not.toMatch(/^Target is a framework-controlled component/);
    // 条件式表述（"if it reports ..."）代替无条件断言
    expect(hint).toMatch(/if it/i);
    // 仍须给出可执行的下一步
    expect(hint).toContain("vortex_observe");
  });

  // 反例来源（codex 复核 R1）：
  // JS_EXECUTION_ERROR **不总是**"调用者的 JS 抛异常"——
  // extension/src/handlers/query.ts:1904/1932/1966/2016/2036/2057/2078/2102/2148/2187/2219
  // 用它报告 "executeScript returned no result"；handlers/capture.ts:161 是
  // "Failed to compute clip"；lib/platform-fonts.ts:33-34,70-71 是读不到指纹 / 没有 objectId；
  // lib/router.ts:106-111 把任意裸错误映射到此码。
  // ⇒ 不得承诺 message 带 JS 异常原文，也不得断言一定是参数问题。
  it("JS_EXECUTION_ERROR hint 不承诺错误原文是 JS 异常，也不断言一定是参数问题", () => {
    const hint = DEFAULT_ERROR_META.JS_EXECUTION_ERROR.hint;
    expect(hint).not.toMatch(/carries the JavaScript error/i);
    expect(hint).not.toMatch(/SyntaxError/i);
    expect(hint).not.toMatch(/fix the argument/i);
    // 条件式表述："若错误信息指向代码/参数问题才调整重试"
    expect(hint).toMatch(/if it points/i);
    // 兜底下一步：换个观察手段，而不是死等
    expect(hint).toContain("vortex_observe");
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

  it("不含指向不可见字段的措辞", () => {
    expect(forbiddenHits(PAGE_NOT_READY_INJECT_HINT)).toEqual([]);
  });
});
