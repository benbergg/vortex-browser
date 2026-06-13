/**
 * TDD: vortex_drag schema 注册测试。
 * 验证工具出现在公开工具列表、schema 字段正确、dispatch 路由。
 */

import { describe, it, expect } from "vitest";
import { getToolDefs } from "../src/tools/registry.js";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("vortex_drag: schema 注册", () => {
  const defs = getToolDefs();
  const drag = defs.find(d => d.name === "vortex_drag");

  it("vortex_drag 在公开工具列表中", () => {
    expect(drag).toBeDefined();
  });

  it("vortex_drag.action = mouse.dragElement", () => {
    expect(drag?.action).toBe("mouse.dragElement");
  });

  it("schema 包含 startRef、endRef (required)", () => {
    const props = (drag?.schema as { properties: Record<string, unknown>; required?: string[] } | undefined);
    expect(props?.properties).toHaveProperty("startRef");
    expect(props?.properties).toHaveProperty("endRef");
    expect(props?.required).toContain("startRef");
    expect(props?.required).toContain("endRef");
  });

  it("schema 包含可选的 steps", () => {
    const props = (drag?.schema as { properties: Record<string, unknown> } | undefined);
    expect(props?.properties).toHaveProperty("steps");
  });

  it("schema 包含 tabId、frameId tab 字段", () => {
    const props = (drag?.schema as { properties: Record<string, unknown> } | undefined);
    expect(props?.properties).toHaveProperty("tabId");
    expect(props?.properties).toHaveProperty("frameId");
  });

  it("description 长度 ≤ 180 char", () => {
    expect(drag?.description.length).toBeLessThanOrEqual(180);
  });

  it("properties 中无 description 字段（I15 §0.2.1 规则）", () => {
    const props = (drag?.schema as { properties: Record<string, unknown> } | undefined);
    if (!props) return;
    for (const [k, v] of Object.entries(props.properties)) {
      expect(
        typeof v === "object" && v !== null && "description" in v,
        `vortex_drag.${k} 不应有 description`,
      ).toBe(false);
    }
  });
});

describe("vortex_drag: dispatch 路由", () => {
  it("dispatchNewTool('vortex_drag') → null（透传到 toolDef.action）", () => {
    // vortex_drag 无需参数重塑，dispatcher 返回 null 表示透传
    const result = dispatchNewTool("vortex_drag", { startRef: "@e1", endRef: "@e2" });
    expect(result).toBeNull();
  });
});

describe("vortex_drag: I15 内部化列表不含此工具", () => {
  it("I15 internalized 列表中的 'vortex_drag' 不阻止新工具(需从内部化列表删除)", () => {
    // vortex_drag 是新工具，不应在 internalized 黑名单中出现
    // 这个测试要求 I15 测试文件中删除 'vortex_drag' 从 internalized 列表
    // (它此前被列为已内部化的旧 drag 工具)
    const defs = getToolDefs();
    const names = new Set(defs.map(d => d.name));
    expect(names.has("vortex_drag")).toBe(true);
  });
});
