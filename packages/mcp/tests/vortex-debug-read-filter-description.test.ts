/**
 * Author: qingwa
 * Description: V2 P0 修复 (N0060-V2 D16 真发现):
 *   vortex_debug_read.filter 子字段未文档化
 *   见 V2 实施计划 + V2 评审意见 §1.2 + D16-可观察性.md
 *
 * 修复目标:
 *   schemas-public.ts vortex_debug_read filter 字段必须加 description +
 *   子字段示例 (level / pattern / statusMin / statusMax), 让 LLM 知道
 *   handler 已实现但 schema 未暴露的子字段可用 (handler.ts:160, 305-321)
 *
 * TDD 红→绿:
 *   - 本测试 (红) 写完后应 fail (filter 当前无 description)
 *   - 修 schemas-public.ts:201 filter 字段加 description
 *   - 测试变绿
 *
 * 参考: vortex-wait-for-description.test.ts (B3-1 文档化修复模式)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SRC = readFileSync(
  join(__dirname, "..", "src", "tools", "schemas-public.ts"),
  "utf8",
);

function getDebugReadDescription(): string {
  const m = SCHEMA_SRC.match(
    /name:\s*["']vortex_debug_read["'][\s\S]*?description:\s*([\s\S]*?),\s*schema:\s*\{/,
  );
  expect(m, "vortex_debug_read description block").not.toBeNull();
  return m![1]
    .replace(/"\s*\+\s*"/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function getDebugReadFilterFieldDescription(): string {
  // 找 vortex_debug_read filter 字段 (允许跨行) 的 description
  const m = SCHEMA_SRC.match(
    /name:\s*["']vortex_debug_read["'][\s\S]*?filter:\s*\{[\s\S]*?description:\s*["'`]([^"'`]+)["'`]/,
  );
  if (!m) return "";
  return m![1].trim();
}

describe("vortex_debug_read filter 子字段 description 文档化 (V2 P0 修复 D16)", () => {
  it("vortex_debug_read filter 字段有 description (文档化核心, 修复前 fail)", () => {
    const desc = getDebugReadFilterFieldDescription();
    // 修复前 filter: { type: "object" } 无 description, 返 ""
    // 修复后 filter: { type: "object", description: "..." } 应非空
    expect(
      desc,
      "schemas-public.ts vortex_debug_read.filter 必须有 description (当前无, 修复前 fail)",
    ).not.toBe("");
  });

  it("filter description 包含 console 子字段示例 level (handler console.ts:160 已实现)", () => {
    const desc = getDebugReadFilterFieldDescription();
    // handler 实际接 args.level, 文档化必须提到
    expect(
      desc,
      `filter description 必须包含 console 子字段 'level', 实测 desc: ${desc}`,
    ).toMatch(/level/);
  });

  it("filter description 包含 network 子字段示例 pattern (handler network.ts:305-321 已实现)", () => {
    const desc = getDebugReadFilterFieldDescription();
    // handler 实际接 args.url (line 305) / args.urlPattern (line 253) / 实际错误信息说 'pattern',
    // 修复统一为 pattern
    expect(
      desc,
      `filter description 必须包含 network 子字段 'pattern', 实测 desc: ${desc}`,
    ).toMatch(/pattern/);
  });

  it("filter description 包含 network 子字段 statusMin (handler network.ts:307 已实现)", () => {
    const desc = getDebugReadFilterFieldDescription();
    expect(
      desc,
      `filter description 必须包含 network 子字段 'statusMin', 实测 desc: ${desc}`,
    ).toMatch(/statusMin/);
  });

  it("filter description 包含 network 子字段 statusMax (handler network.ts:308 已实现)", () => {
    const desc = getDebugReadFilterFieldDescription();
    // V2 P0 修复 D16: description 用 'statusMin/Max' 缩写形式 (60 字符总约束下),
    // 测试接受 'statusMax' 或 'statusMin/Max' 任一形式
    expect(
      desc,
      `filter description 必须包含 network status range (statusMax 或 statusMin/Max), 实测 desc: ${desc}`,
    ).toMatch(/statusMax|statusMin\/Max/);
  });

  it("description 总长度 ≤ 180 char (I15 invariant 约束, 顶层 description, source=request 能力追加后放宽)", () => {
    const desc = getDebugReadDescription();
    // 顶层 description 放宽至 I15 v5.0 全局上限 180 char
    // source=request 新能力将 description 扩至 ~76 char (在 180 之内)
    // filter 子字段 description 不在 I15 invariant 约束内 (可详尽)
    expect(desc.length).toBeLessThanOrEqual(180);
  });
});
