/**
 * TDD: vortex_mouse_click schema 注册测试。
 * 坐标点击工具(canvas/地图/无 ref 场景)——handler mouse.click 早已实现,
 * 此前只暴露坐标版 mouse.drag(vortex_mouse_drag),漏了坐标 click。本测试
 * 锁住工具出现在公开列表、schema/action 正确、dispatch 透传路由。
 */

import { describe, it, expect } from "vitest";
import { getToolDefs } from "../src/tools/registry.js";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("vortex_mouse_click: schema 注册", () => {
  const defs = getToolDefs();
  const click = defs.find(d => d.name === "vortex_mouse_click");

  it("vortex_mouse_click 在公开工具列表中", () => {
    expect(click).toBeDefined();
  });

  it("vortex_mouse_click.action = mouse.click（复用已实现的 handler）", () => {
    expect(click?.action).toBe("mouse.click");
  });

  it("schema 含 x、y (required)", () => {
    const s = click?.schema as { properties: Record<string, unknown>; required?: string[] } | undefined;
    expect(s?.properties).toHaveProperty("x");
    expect(s?.properties).toHaveProperty("y");
    expect(s?.required).toContain("x");
    expect(s?.required).toContain("y");
  });

  it("schema 含可选 button、coordSpace（frame→viewport 换算）", () => {
    const s = click?.schema as { properties: Record<string, unknown> } | undefined;
    expect(s?.properties).toHaveProperty("button");
    expect(s?.properties).toHaveProperty("coordSpace");
  });

  it("schema 含 tabId、frameId tab 字段", () => {
    const s = click?.schema as { properties: Record<string, unknown> } | undefined;
    expect(s?.properties).toHaveProperty("tabId");
    expect(s?.properties).toHaveProperty("frameId");
  });

  it("description 长度 ≤ 180 char", () => {
    expect(click?.description.length).toBeLessThanOrEqual(180);
  });

  it("properties 中无 description 字段（I15 §0.2.1 规则）", () => {
    const s = click?.schema as { properties: Record<string, unknown> } | undefined;
    if (!s) return;
    for (const [k, v] of Object.entries(s.properties)) {
      expect(
        typeof v === "object" && v !== null && "description" in v,
        `vortex_mouse_click.${k} 不应有 description`,
      ).toBe(false);
    }
  });
});

describe("vortex_mouse_click: dispatch 路由", () => {
  it("dispatchNewTool('vortex_mouse_click') → null（透传到 toolDef.action=mouse.click）", () => {
    // 无 ref/target,无需参数重塑,dispatcher 返回 null 表示透传(同 vortex_mouse_drag)。
    const result = dispatchNewTool("vortex_mouse_click", { x: 100, y: 200 });
    expect(result).toBeNull();
  });
});
