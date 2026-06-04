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

/** 读取 [data-testid="result"] 的可见文本 */
export async function readResult(ctx: CaseContext): Promise<string> {
  const res = await ctx.call("vortex_extract", {
    target: "[data-testid=\"result\"]",
    include: ["text"],
  });
  return extractText(res);
}

/** 断言 result 区包含子串（自带重试，避免 v-model 异步 commit 导致的 flaky）。
 * retry 窗口 6×500ms = 3s，覆盖 Element Plus 某些场景 Vue flush 的 tail 延迟。*/
export async function assertResultContains(ctx: CaseContext, expected: string): Promise<void> {
  let lastText = "";
  for (let i = 0; i < 6; i++) {
    lastText = await readResult(ctx);
    if (lastText.includes(expected)) return;
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

/** 取指定 target 的可见文本（include:["text"]）。 */
async function extractTargetText(ctx: CaseContext, target: string): Promise<string> {
  const res = await ctx.call("vortex_extract", { target, include: ["text"] });
  return extractText(res);
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
