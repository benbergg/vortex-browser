// case 公共辅助（文件名以 _ 开头，runner 的 listCaseNames 只收 .case.ts，不会当 case 跑）

import type { CaseContext } from "../src/types.js";
import {
  exactMatch,
  fuzzyMatch,
  numericWithinBand,
  containsAll,
  notContains,
} from "../src/runner/extract-assert.js";

/** MCP 工具返回值 → 纯文本 */
export function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item) {
      parts.push(String((item as { text: unknown }).text));
    }
  }
  return parts.join("\n");
}

/** evaluate 返回值 → JS 原生值（vortex_evaluate 的 content 是 JSON 字符串）*/
export function extractEvalJson<T = unknown>(res: unknown): T {
  const text = extractText(res);
  return JSON.parse(text) as T;
}

/**
 * 从 observe 快照文本里按 accessible name 找 ref(支持 v0.8 hashed ref:
 * @eN / @fNeM / @<hash>:eN / @<hash>:fNeM)。observe 的 ref 每次运行变,
 * case 不能硬编码,须 observe→findRef→act。范式来自 shadow-dom-counter.case.ts。
 */
export function findRef(snapshot: string, name: string): string | null {
  // a11y-tree 格式：`- role "name" [ref=@..]`，ref 在 [ref=] 内（旧扁平是行首 @ref [role] "name"）。
  // 兼容 hashed 形态 @a1b2:e12 / @a1b2:f34e7 与无 hash @e12 / @f34e7。
  const re = new RegExp(`-\\s+\\S+\\s+"([^"]*?)"\\s+\\[ref=(@[\\w:]+)\\]`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[1].trim() === name) return m[2];
  }
  return null;
}

/** 读取 [data-testid="result"] 的可见文本 */
export async function readResult(ctx: CaseContext): Promise<string> {
  const res = await ctx.call("vortex_extract", {
    target: "[data-testid=\"result\"]",
    include: ["text"],
  });
  return extractText(res);
}

/** 断言 result 区包含子串（自带重试，避免 v-model 异步 commit 导致的 flaky）。
 * retry 窗口 6×500ms = 3s，覆盖 Element Plus 某些场景 Vue flush 的 tail 延迟。
 * 命中期望文本时也要过一次 ctx.assert：runner 侧的断言计数（防假绿闸门）只认
 * ctx.assert，这里直接 return 会让本用例被误判成"零断言 → assertion_failure"。*/
export async function assertResultContains(ctx: CaseContext, expected: string): Promise<void> {
  let lastText = "";
  for (let i = 0; i < 6; i++) {
    lastText = await readResult(ctx);
    if (lastText.includes(expected)) {
      ctx.assert(true, `result 区应包含 "${expected}"`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  ctx.assert(
    false,
    `result 区应包含 "${expected}"，实际: ${lastText.slice(0, 200)}`,
  );
}

// ── 缺口 J：extract 容差断言 helper（包 vortex_extract + extract-assert 纯函数）──
// 标准锚"从正确目标取到的文本是否含 ground-truth 事实"。target 为静态内容时无需重试；
// 异步加载的 case 应先 ctx.call("vortex_wait_for", ...) 再断言。

/**
 * 取指定 target 的可见文本（include:["text"]）。
 * vortex_extract 返回 **JSON 编码** 的值（单元素 → `"Coframe"` 带引号；多元素 → 数组/对象）。
 * 解析还原成裸字符串供 exact/fuzzy 相等判定；解析为非字符串（数组/对象）或解析失败则保留原文
 * （containsAll/numericBand 走子串/抽数字，原文亦可）。2026-06-04 live 验收坐实此 unwrap 必需。
 */
async function extractTargetText(ctx: CaseContext, target: string): Promise<string> {
  const res = await ctx.call("vortex_extract", { target, include: ["text"] });
  const raw = extractText(res);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // 非 JSON（旧形态/纯文本）→ 用原文
  }
  return raw;
}

/** 提取文本规范化后 == expected（fuzzy 给定阈值则走 Jaro-Winkler ≥ 阈值）。 */
export async function assertExtractEquals(
  ctx: CaseContext,
  target: string,
  expected: string,
  opts?: { fuzzy?: number },
): Promise<void> {
  const text = await extractTargetText(ctx, target);
  const ok =
    opts?.fuzzy !== undefined ? fuzzyMatch(text, expected, opts.fuzzy) : exactMatch(text, expected);
  ctx.assert(
    ok,
    `extract(${target}) 应${opts?.fuzzy !== undefined ? `≈ (fuzzy≥${opts.fuzzy})` : " =="} "${expected}"，实际: ${text.slice(0, 200)}`,
  );
}

/** 提取文本（N 行表/容器）应包含全部 expectedValues（完整性）。 */
export async function assertExtractContainsAll(
  ctx: CaseContext,
  target: string,
  expectedValues: string[],
): Promise<void> {
  const text = await extractTargetText(ctx, target);
  const r = containsAll(text, expectedValues);
  ctx.assert(
    r.ok,
    `extract(${target}) 缺失关键值: ${r.missing.join(", ")}；实际: ${text.slice(0, 200)}`,
  );
}

/** 提取文本里第一个数字应落 expected±band（抗真站数值漂移，支持 k/m 后缀）。 */
export async function assertExtractNumericBand(
  ctx: CaseContext,
  target: string,
  expected: number,
  band: number,
): Promise<void> {
  const text = await extractTargetText(ctx, target);
  ctx.assert(
    numericWithinBand(text, expected, band),
    `extract(${target}) 数值应落 ${expected}±${band}，实际文本: ${text.slice(0, 200)}`,
  );
}

/** 负向：提取文本不应包含 forbidden（target 之外的值不该被取到）。 */
export async function assertExtractNotContains(
  ctx: CaseContext,
  target: string,
  forbidden: string,
): Promise<void> {
  const text = await extractTargetText(ctx, target);
  ctx.assert(
    notContains(text, forbidden),
    `extract(${target}) 不应包含 "${forbidden}"，实际: ${text.slice(0, 200)}`,
  );
}
