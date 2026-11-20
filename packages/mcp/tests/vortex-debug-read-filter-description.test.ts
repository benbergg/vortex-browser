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
import { dispatchNewTool } from "../src/tools/dispatch.js";
import { PUBLIC_TOOLS } from "../src/tools/schemas-public.js";

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

/**
 * D-1(2026-11-20): 公开契约与运行时不一致 + 参数形状错误时文案指错字段。
 *
 * 运行时真相：
 *   - dispatch 的 network pattern 校验读 args.pattern（顶层）或 filter.pattern
 *   - extension network.ts 读 args.includeResources（顶层）
 *   → 这两个平铺参数公开面此前没声明，模型只能塞进 filter；
 *     filter 是字符串时 Object.assign 静默丢弃它，随后报 "pattern is required"，
 *     把「filter 形状错」误报成「pattern 缺失」。
 */
describe("D-1: 公开契约与运行时一致 + filter 形状错报错指对字段", () => {
  // 断言**公开 schema 对象**而不是源码文本：源码文本正则会命中别的工具的同名
  // 属性（审查发现：这样写修复前也是绿的，等于没有回归能力）。
  const debugReadProps = (() => {
    const tool = PUBLIC_TOOLS.find((t) => t.name === "vortex_debug_read");
    expect(tool, "vortex_debug_read 必须在 PUBLIC_TOOLS 里").toBeDefined();
    const props = (tool!.schema as { properties?: Record<string, { type?: string }> }).properties ?? {};
    return props;
  })();

  it("公开 schema 声明运行时实际接受的顶层 pattern（string）", () => {
    expect(debugReadProps.pattern, "公开面缺顶层 pattern → 模型只能塞进 filter").toBeDefined();
    expect(debugReadProps.pattern!.type).toBe("string");
  });

  it("公开 schema 声明运行时实际接受的顶层 includeResources（boolean）", () => {
    expect(
      debugReadProps.includeResources,
      "公开面缺顶层 includeResources → 模型无法请求静态资源",
    ).toBeDefined();
    expect(debugReadProps.includeResources!.type).toBe("boolean");
  });

  it("filter 传字符串 → 报 filter 形状错，不再报 'pattern is required'", () => {
    let err: unknown;
    try {
      dispatchNewTool("vortex_debug_read", { source: "network", filter: "example" });
    } catch (e) {
      err = e;
    }
    expect(err, "字符串 filter 必须被拒").toBeDefined();
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toMatch(/filter must be an object/i);
    expect(msg, "不能再把形状错报成 pattern 缺失").not.toMatch(/pattern is required/i);
  });

  it("filter 传数组 → 同样报 filter 形状错", () => {
    let err: unknown;
    try {
      dispatchNewTool("vortex_debug_read", { source: "network", filter: ["example"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err instanceof Error ? err.message : String(err)).toMatch(/filter must be an object/i);
  });

  it("filter 传对象仍正常路由（不回归）", () => {
    const r = dispatchNewTool("vortex_debug_read", {
      source: "network",
      filter: { pattern: "/api/" },
    });
    expect(r?.action).toBe("network.getLogs");
    expect(r?.params.pattern).toBe("/api/");
  });

  it("顶层 pattern 与 includeResources 透传到 handler 参数", () => {
    const r = dispatchNewTool("vortex_debug_read", {
      source: "network",
      pattern: "/api/",
      includeResources: true,
    });
    expect(r?.action).toBe("network.getLogs");
    expect(r?.params.pattern).toBe("/api/");
    expect(r?.params.includeResources).toBe(true);
  });
});
