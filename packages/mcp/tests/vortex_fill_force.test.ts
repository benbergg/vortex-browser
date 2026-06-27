/**
 * TDD: BUG-011 (N0060 京东选品评测) — vortex_fill schema 必须暴露 force 参数。
 *
 * Background (来源: reports/jd-dogfood-V1/{3C,家电,服饰}/03-阶段1-搜索入口.md D4):
 *   京东首页 sticky 搜索栏在 transition 中, vortex_fill 触发 NOT_STABLE。
 *   dom.ts:581 已经在 waitActionable 处透传 args.force,但 MCP schema 缺
 *   `force` 字段 → 用户从 LLM 客户端透传 force=true 会被 schema 校验拒绝。
 *
 *   修复目标: vortex_fill schema 暴露 `force: { type: "boolean" }`,允许
 *   透传给 waitActionable 跳过稳定性检查(sticky/fixed 容器场景)。
 *
 * I15 invariants 必须保留:
 *   - properties 不带 description 字段(§0.2.1 字节预算)
 *   - public tool description ≤ 60 字符
 *   - 不在 required 列表(可选,默认 false → 保留原行为)
 *
 * Fix site: packages/mcp/src/tools/schemas-public.ts:315-328 (vortex_fill)
 */
import { describe, it, expect } from "vitest";
import { getToolDef } from "../src/tools/registry.js";

describe("vortex_fill force — public schema (BUG-011)", () => {
  const fill = getToolDef("vortex_fill");
  const props = (fill?.schema as { properties: Record<string, any> }).properties;

  it("vortex_fill is registered as a public tool", () => {
    expect(fill).toBeDefined();
  });

  it("properties.force is declared (BUG-011 修复点)", () => {
    expect(props.force).toBeDefined();
  });

  it("force is type boolean", () => {
    expect(props.force.type).toBe("boolean");
  });

  it("force carries NO description in public schema (I15 §0.2.1 byte budget)", () => {
    expect(props.force.description).toBeUndefined();
  });

  it("force is NOT in `required` (optional, default off — 保留原 NOT_STABLE 行为)", () => {
    const required = (fill?.schema as { required?: string[] }).required ?? [];
    expect(required.includes("force")).toBe(false);
  });

  it("force does not collide with existing fill params (target/value/widget/tabId/frameId)", () => {
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["target", "value", "widget", "force"]),
    );
  });
});

describe("vortex_fill force — I15 byte budget preserved", () => {
  // I15.tools-list-budget.test.ts 已经校验整个 tools/list payload ≤ 5200 B。
  // 这里 sanity-check description 没被新选项撑爆。
  const fill = getToolDef("vortex_fill");

  it("public vortex_fill description still ≤ 60 char (I15 limit)", () => {
    expect((fill?.description ?? "").length).toBeLessThanOrEqual(60);
  });
});
