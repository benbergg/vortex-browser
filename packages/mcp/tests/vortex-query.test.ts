// vortex-query.test.ts
// MCP 侧测试:schema 注册 + dispatch 路由 + 描述字段

import { describe, it, expect } from "vitest";
import { getToolDefs, getToolDef } from "../src/tools/registry.js";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("vortex_query schema 注册", () => {
  it("vortex_query 出现在公开 tools/list", () => {
    const names = getToolDefs().map((d) => d.name);
    expect(names).toContain("vortex_query");
  });

  it("vortex_query action 路由到 query.queryPage", () => {
    const def = getToolDef("vortex_query");
    expect(def).toBeDefined();
    expect(def!.action).toBe("query.queryPage");
  });

  it("vortex_query description 包含 text 和 css 关键词", () => {
    const def = getToolDef("vortex_query");
    expect(def!.description.toLowerCase()).toMatch(/text|grep/);
    expect(def!.description.toLowerCase()).toMatch(/css|find/);
  });

  it("vortex_query description 长度 ≤ 180 char", () => {
    const def = getToolDef("vortex_query");
    expect(def!.description.length).toBeLessThanOrEqual(180);
  });

  it("vortex_query schema 有 mode 和 pattern 字段", () => {
    const def = getToolDef("vortex_query");
    const schema = def!.schema as { properties: Record<string, unknown> };
    expect(schema.properties.mode).toBeDefined();
    expect(schema.properties.pattern).toBeDefined();
  });

  it("vortex_query schema mode enum 包含 text 和 css", () => {
    const def = getToolDef("vortex_query");
    const schema = def!.schema as { properties: { mode: { enum: string[] } } };
    expect(schema.properties.mode.enum).toContain("text");
    expect(schema.properties.mode.enum).toContain("css");
  });
});

describe("vortex_query dispatch 路由", () => {
  it("dispatchNewTool 对 vortex_query 返回 action=query.queryPage", () => {
    const result = dispatchNewTool("vortex_query", { mode: "text", pattern: "foo" });
    // vortex_query 无需 reshape，返回 null 走 toolDef.action 默认路由
    // 或返回 { action: "query.queryPage", params: ... }
    // 两种都可接受，关键是 action 最终正确
    if (result !== null) {
      expect(result.action).toBe("query.queryPage");
    } else {
      // null 表示直接用 toolDef.action，也正确
      const def = getToolDef("vortex_query");
      expect(def!.action).toBe("query.queryPage");
    }
  });
});
