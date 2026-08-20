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

  // 长度上限只由 I15.tools-list-budget 一处断言。这里曾抄了一份 230,加 mode=tokens
  // 时只改了 I15,单文件跑全绿、全量跑才红 —— 同一不变量抄两份就是这个下场。
  // 换成不重叠的那半:每个 enum 里的 mode 都得在 description 里出现,否则新增 mode
  // 对 LLM 不可发现(这正是压缩 description 时最容易丢的东西)。
  it("每个 mode 都在 tools/list 文本里被提到", () => {
    const def = getToolDef("vortex_query");
    const schema = def!.schema as {
      properties: { mode: { enum: string[]; description?: string } };
    };
    // 工具 description 与 mode 字段 description 都进 tools/list,合起来算可发现面
    const visible = def!.description + " " + (schema.properties.mode.description ?? "");
    for (const mode of schema.properties.mode.enum) {
      expect(visible, `mode=${mode} 在 tools/list 里没有任何说明`).toContain(mode);
    }
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

  it("elements mode 在 enum 里,且 dimensions 字段已声明", () => {
    const def = getToolDef("vortex_query");
    const schema = def!.schema as {
      properties: { mode: { enum: string[] }; dimensions?: { type: string } };
    };
    expect(schema.properties.mode.enum).toContain("elements");
    expect(schema.properties.dimensions?.type).toBe("string");
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

describe("maxResults schema 范围要覆盖所有 mode 的内部上限", () => {
  const field = () => {
    const def = getToolDef("vortex_query")!;
    return (def.schema as { properties: Record<string, { maximum?: number; minimum?: number }> })
      .properties.maxResults;
  };

  it("chart 内部上限 2000,schema 不能把它卡在更小的值上", () => {
    // f7ecb25 给 tokens 补约束时写了 maximum:200,chart 传 1000 会在进 handler 前被拒
    expect(field().maximum).toBeGreaterThanOrEqual(2000);
  });

  it("下界仍锁在 1", () => {
    expect(field().minimum).toBe(1);
  });
});
