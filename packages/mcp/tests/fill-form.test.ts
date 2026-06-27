// TDD: vortex_fill_form 批量填表工具测试
// 工具横向优化 T7: fields[] 循环复用 fill 分流, 部分成功语义

import { describe, it, expect } from "vitest";
import { getToolDef, getToolDefs } from "../src/tools/registry.js";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("vortex_fill_form: schema 注册", () => {
  it("vortex_fill_form 出现在公开 tools/list", () => {
    const names = getToolDefs().map((d) => d.name);
    expect(names).toContain("vortex_fill_form");
  });

  it("vortex_fill_form schema 包含 fields 数组", () => {
    const def = getToolDef("vortex_fill_form");
    expect(def).toBeDefined();
    const props = (def!.schema as { properties: Record<string, any> }).properties;
    expect(props.fields).toBeDefined();
    expect(props.fields.type).toBe("array");
  });

  it("vortex_fill_form schema.fields.items 包含 target 和 value", () => {
    const def = getToolDef("vortex_fill_form");
    const props = (def!.schema as { properties: Record<string, any> }).properties;
    const items = props.fields.items as Record<string, any>;
    expect(items.properties?.target).toBeDefined();
    expect(items.properties?.value).toBeDefined();
  });

  it("vortex_fill_form schema.fields.items 支持可选 widget", () => {
    const def = getToolDef("vortex_fill_form");
    const props = (def!.schema as { properties: Record<string, any> }).properties;
    const items = props.fields.items as Record<string, any>;
    expect(items.properties?.widget).toBeDefined();
  });

  it("vortex_fill_form schema.required 包含 fields", () => {
    const def = getToolDef("vortex_fill_form");
    const required = (def!.schema as { required: string[] }).required;
    expect(required).toContain("fields");
  });

  it("vortex_fill_form description 长度 ≤ 180 char", () => {
    const def = getToolDef("vortex_fill_form");
    expect(def!.description.length).toBeLessThanOrEqual(180);
  });

  it("vortex_fill_form 的 action 字段存在", () => {
    const def = getToolDef("vortex_fill_form");
    expect(def!.action).toBeTruthy();
  });
});

describe("vortex_fill_form: dispatch 路由", () => {
  it("dispatchNewTool 对 vortex_fill_form 返回 fill_form action", () => {
    // dispatch 层返回特殊标记，让 server.ts 识别并做批量处理
    const result = dispatchNewTool("vortex_fill_form", {
      fields: [{ target: "#name", value: "Alice" }],
    });
    // vortex_fill_form 需要特殊处理（server 层），dispatch 返回 null 透传 toolDef.action
    // 或返回 {action: "fill_form", params}。验证：不会 throw，返回 null 或 valid 对象。
    expect(result === null || (typeof result === "object" && "action" in result)).toBe(true);
  });

  it("dispatchNewTool 对 fields=[] 不 throw（空字段由 server 层语义报错）", () => {
    expect(() =>
      dispatchNewTool("vortex_fill_form", { fields: [] }),
    ).not.toThrow();
  });
});

describe("vortex_fill_form: schema 属性不带 description（I15 §0.2.1）", () => {
  it("inputSchema properties 字段不带 description", () => {
    const def = getToolDef("vortex_fill_form");
    function checkNoPropertyDescription(schema: any, path = ""): void {
      if (!schema || typeof schema !== "object") return;
      if (schema.properties && typeof schema.properties === "object") {
        for (const [k, v] of Object.entries(schema.properties)) {
          if (v && typeof v === "object" && "description" in (v as object)) {
            throw new Error(`${path}.properties.${k} has description (forbidden by §0.2.1)`);
          }
          checkNoPropertyDescription(v, `${path}.properties.${k}`);
        }
      }
      if (schema.items) checkNoPropertyDescription(schema.items, `${path}.items`);
    }
    expect(() => checkNoPropertyDescription(def!.schema, "")).not.toThrow();
  });
});
