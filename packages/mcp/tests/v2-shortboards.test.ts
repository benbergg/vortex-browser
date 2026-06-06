// v2.1 短板 v2.2 实施方案 —— 4 个 TC 的回归测试。
// spec: 12-Projects/0000-vortex优化/20260605-vortex优化-v2.1-实施方案.md
// PR-A：纯 schema 暴露 + 文档化，零后端代码改动。
//
// 4 个 TC：
//   TC-11  P0-11  vortex_evaluate 失败场景（v2.2 实证后仅文档化）
//   TC-12  P0-12  vortex_tab_list 暴露
//   TC-13  P1-13  vortex_history 暴露
//   TC-14  P1-14  vortex_storage 无 key 行为文档化

import { describe, it, expect } from "vitest";
import { getToolDefs, getToolDef } from "../src/tools/registry.js";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("TC-12: vortex_tab_list 暴露（P0-12）", () => {
  it("vortex_tab_list 出现在公开 tools/list", () => {
    const names = getToolDefs().map((d) => d.name);
    expect(names).toContain("vortex_tab_list");
  });

  it("vortex_tab_list action 路由到 tab.list", () => {
    const def = getToolDef("vortex_tab_list");
    expect(def).toBeDefined();
    expect(def!.action).toBe("tab.list");
  });

  it("vortex_tab_list description 提示 LLM 用途", () => {
    // description 必须引导 LLM 知道"列 tabId 后才能用 tabId 操作"
    const def = getToolDef("vortex_tab_list");
    expect(def!.description).toMatch(/tab/i);
  });

  it("vortex_tab_list schema 是无入参对象（{properties:{}, required:[]})", () => {
    const def = getToolDef("vortex_tab_list");
    const schema = def!.schema as { type: string; properties: object; required: unknown[] };
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({});
    expect(schema.required).toEqual([]);
  });
});

describe("TC-13: vortex_history 暴露（P1-13）", () => {
  it("vortex_history 出现在公开 tools/list", () => {
    const names = getToolDefs().map((d) => d.name);
    expect(names).toContain("vortex_history");
  });

  it("vortex_history action 路由到 page.back", () => {
    // 注意:dispatch.ts 在 case "vortex_history" 中按 direction 重新路由,
    // 所以 toolDef.action 写 page.back 占位,实际由 dispatcher 决定 page.back / page.forward。
    const def = getToolDef("vortex_history");
    expect(def!.action).toBe("page.back");
  });

  it("vortex_history description 提示 back/forward", () => {
    const def = getToolDef("vortex_history");
    expect(def!.description).toMatch(/back|forward|history/i);
  });

  it("vortex_history schema.direction enum 包含 back / forward", () => {
    const def = getToolDef("vortex_history");
    const schema = def!.schema as {
      properties: { direction: { enum: string[] } };
    };
    expect(schema.properties.direction.enum).toEqual(expect.arrayContaining(["back", "forward"]));
  });

  it("vortex_history direction:back → page.back", () => {
    const { action } = dispatchNewTool("vortex_history", { direction: "back" })!;
    expect(action).toBe("page.back");
  });

  it("vortex_history direction:forward → page.forward", () => {
    const { action } = dispatchNewTool("vortex_history", { direction: "forward" })!;
    expect(action).toBe("page.forward");
  });

  it("vortex_history 省略 direction → 默认 page.back", () => {
    const { action } = dispatchNewTool("vortex_history", {})!;
    expect(action).toBe("page.back");
  });

  it("vortex_history 透传 tabId 给 page.back/forward", () => {
    const { params } = dispatchNewTool("vortex_history", { direction: "back", tabId: 42 })!;
    expect(params.tabId).toBe(42);
  });
});

describe("TC-14: vortex_storage 无 key 行为文档化（P1-14）", () => {
  // v2.2 实测确认:不传 key 调 get 实测返回所有 key-value 完整对象。
  // 真正的真问题不是功能缺失,是 description 未文档化。
  //
  // 60 char 节字节约束下,description 优先表达"全量接口可用"（含 cookies）
  // + "omit key = list all" 核心信息。get/set/session-* 等具体 op 名靠
  // schema.enum 透出,不挤 description。
  it("vortex_storage description 提示 omit key → enumerate all", () => {
    const def = getToolDef("vortex_storage");
    expect(def).toBeDefined();
    // 必须让 LLM 知道:不传 key 的 get 是"列出所有"语义
    expect(def!.description).toMatch(/omit|all|keys|enumerate/i);
  });

  it("vortex_storage description 包含 cookies 关键词", () => {
    // cookies-get 是 v2 实测发现的"全量接口" 关键 op,必须出现在 description
    // 让 LLM 知道"想要看完整 cookies / 完整 storage,omit key 即可"。
    const def = getToolDef("vortex_storage");
    expect(def!.description.toLowerCase()).toContain("cookies");
  });

  it("vortex_storage 长度 ≤ 60 char（I15 节字节）", () => {
    const def = getToolDef("vortex_storage");
    expect(def!.description.length).toBeLessThanOrEqual(60);
  });
});

describe("TC-11: vortex_evaluate async 模式语义文档化（P0-11）", () => {
  // v2.2 实测:async 模式下,code 是 async 函数体(含 return),不是 async 表达式。
  // 失败场景:
  //   - () => obj (未调用箭头函数)
  //   - function f() {...} (未调用 function 声明)
  //   - async IIFE 表达式 (async () => obj)()
  // description 必须把"async 模式是函数体"说清楚,让 LLM 知道:
  //   1. sync 模式:表达式或 IIFE 形式
  //   2. async 模式:函数体(含 return)
  it("vortex_evaluate description 包含 async 语义提示", () => {
    const def = getToolDef("vortex_evaluate");
    expect(def).toBeDefined();
    // 必须包含 "async" 提示
    expect(def!.description).toMatch(/async/i);
  });

  it("vortex_evaluate description 包含函数体/return 提示", () => {
    const def = getToolDef("vortex_evaluate");
    const d = def!.description.toLowerCase();
    // 描述要说明:async 模式下 code 应该是函数体(含 return)
    expect(d).toMatch(/return|body|expression/i);
  });

  it("vortex_evaluate 长度 ≤ 60 char（I15 节字节）", () => {
    const def = getToolDef("vortex_evaluate");
    expect(def!.description.length).toBeLessThanOrEqual(60);
  });
});

describe("PR-A 整体回归：公开工具数从 15 → 17", () => {
  it("公开工具总数 = 17（v2.1 PR-A: +vortex_tab_list +vortex_history）", () => {
    expect(getToolDefs().length).toBe(17);
  });
});
