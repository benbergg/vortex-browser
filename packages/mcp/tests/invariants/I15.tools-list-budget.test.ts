// I15: tools/list 字节硬断言 + 数量 + 内部化 grep。
// spec: vortex重构-L4-spec.md §0.2.1 (4800B budget v2.1) + §3.3
//
// v0.8 cap: 4500 → 4600 B。v0.7.x backlog 重新暴露 4 个工具
// (vortex_fill / vortex_evaluate / vortex_mouse_drag / vortex_file_upload)，
// payload 实测 4537 B。trim description 会损 LLM 可读性，因此调升 cap
// 而非压缩字符。下一个调整窗口预留至 v0.9 再 review。
//
// v0.8.x: 4600 → 4700 B。vortex_screenshot 增加 format/quality 字段
// 提升 token 节省能力（caller 可 opt-in jpeg quality，实测体积可降 ~40%），
// description 也要点出此能力以引导 LLM 使用。同样优先 cap 微调而非压缩字符。
//
// v0.8.x P1: 4700 → 4800 B。vortex_extract 增加 scroll(boolean) 公开能力
// （提取前 scroll-until-settled 触发懒加载，解决"懒加载内容对裸 extract
// 不可见"的正确性缺口），新增 schema 字段 ~27B + description 点出能力。
// scroll 是真新增公开能力，cap 微调（+100，与前两次同步长）而非压缩字符。
//
// v2.1 PR-A: 4800 → 5200 B。promote vortex_tab_list + vortex_history 两
// 个 schema 块回公开,2 段 description 重写(evaluate / storage)。后端
// 零代码改动,只 +2 schema 块 + description 改写。两个工具 schema 实测
// 共 +~407B,新 payload 实测 5137B,cap +400 至 5200 留 63B 余量。
//
// v3.1 PR-E-scope-reduced: 5200 → 5300 B。vortex_extract 加 maxLength(number,
// 默认 10KB = 10240 chars) 公开能力 (B3-7 落点修对到 handler + 真测
// truncateWithTextTrailer),新增 schema 字段 ~30B + description 改写
// 提及"maxLength 10KB"。maxLength 是真新增公开能力,cap 微调 (+100,
// 跟历次同步长) 而非压缩字符。新 payload 实测 5225B,留 75B 余量。

import { describe, it, expect } from "vitest";
import { COMMIT_KINDS } from "@vortex-browser/shared";
import { getToolDefs, getInternalToolDef } from "../../src/tools/registry.js";

describe("I15: tools/list budget + count + internalized grep", () => {
  const defs = getToolDefs();
  const toolsListPayload = JSON.stringify(
    defs.map(d => ({ name: d.name, description: d.description, inputSchema: d.schema })),
  );

  it("tools/list 字节 ≤ 5300 B", () => {
    expect(toolsListPayload.length).toBeLessThanOrEqual(5300);
  });

  it("公开工具数量 = 17（v2.1 PR-A: v0.8 15 + tab_list + history）", () => {
    expect(defs.length).toBe(17);
  });

  it("17 个公开工具名匹配 spec L4 §1.1+§1.2 + v2.1 PR-A (v2.1)", () => {
    const names = defs.map(d => d.name).sort();
    expect(names).toEqual([
      "vortex_act",
      "vortex_debug_read",
      "vortex_evaluate",
      "vortex_extract",
      "vortex_file_upload",
      "vortex_fill",
      "vortex_history",
      "vortex_mouse_drag",
      "vortex_navigate",
      "vortex_observe",
      "vortex_press",
      "vortex_screenshot",
      "vortex_storage",
      "vortex_tab_close",
      "vortex_tab_create",
      "vortex_tab_list",
      "vortex_wait_for",
    ]);
  });

  it("v0.5 已删/内部化的工具不在 tools/list", () => {
    const names = new Set(defs.map(d => d.name));
    // v0.8: vortex_fill / vortex_evaluate / vortex_mouse_drag / vortex_file_upload
    // 已从内部化回到公开（v0.7.x backlog promotion）。
    // v2.1 PR-A: vortex_tab_list / vortex_history 也从内部化回到公开。
    const internalized = [
      // 写操作 → act
      "vortex_click", "vortex_type", "vortex_select",
      "vortex_scroll", "vortex_hover", "vortex_drag",
      // 读 → extract / observe
      "vortex_get_text", "vortex_get_html",
      "vortex_frames_list",
      // 等待 → wait_for
      "vortex_wait", "vortex_wait_idle", "vortex_page_info",
      // 调试 → debug_read
      "vortex_console", "vortex_network", "vortex_network_response_body", "vortex_events",
      // 存储 → storage
      "vortex_storage_get", "vortex_storage_set", "vortex_storage_session",
      // 内部化（act/observe 触发）
      "vortex_mouse_click", "vortex_mouse_move",
      "vortex_file_download", "vortex_file_list_downloads",
      "vortex_batch",
      // 删除（无业务价值 / 内部化）
      "vortex_ping",
    ];
    for (const n of internalized) {
      expect(names.has(n)).toBe(false);
    }
  });

  it("description 长度 ≤ 60 char", () => {
    for (const d of defs) {
      expect(d.description.length).toBeLessThanOrEqual(60);
    }
  });

  it("inputSchema 中 properties 字段不带 description（节字节）", () => {
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
      if (schema.oneOf) for (const o of schema.oneOf) checkNoPropertyDescription(o, `${path}.oneOf`);
    }
    for (const d of defs) {
      expect(() => checkNoPropertyDescription(d.schema, d.name)).not.toThrow();
    }
  });
});

// v0.8 H-7 fix: `vortex_fill.kind` 在三处 schema 与 extension commit-drivers
// 的 CommitKind 之间必须严格一致。把 COMMIT_KINDS 拆到 @vortex-browser/shared
// 作为单一真值源后，下面三条测试 lock 公开/内部 schema 与 shared 数组一致，
// 任何一边私自加值/减值都会断在 CI。
describe("H-7: vortex_fill.kind enum stays in sync with shared COMMIT_KINDS", () => {
  it("public vortex_fill.kind.enum == COMMIT_KINDS", () => {
    const fill = getToolDefs().find(d => d.name === "vortex_fill")!;
    const enumVals = (fill.schema as { properties: { kind: { enum: string[] } } }).properties.kind.enum;
    expect([...enumVals].sort()).toEqual([...COMMIT_KINDS].sort());
  });

  it("internal vortex_fill.kind.enum == COMMIT_KINDS", () => {
    const fill = getInternalToolDef("vortex_fill")!;
    const enumVals = (fill.schema as { properties: { kind: { enum: string[] } } }).properties.kind.enum;
    expect([...enumVals].sort()).toEqual([...COMMIT_KINDS].sort());
  });
});

// H-13 fix: destructive tools must carry MCP annotations so LLM clients
// (Claude Code, Cursor, …) can gate them with stricter approval prompts.
describe("H-13: destructive public tools carry annotations.destructiveHint", () => {
  it("vortex_evaluate has destructiveHint=true + openWorldHint=true", () => {
    const evaluate = getToolDefs().find(d => d.name === "vortex_evaluate")!;
    expect(evaluate.annotations?.destructiveHint).toBe(true);
    expect(evaluate.annotations?.openWorldHint).toBe(true);
  });

  it("vortex_file_upload has destructiveHint=true + openWorldHint=true", () => {
    const upload = getToolDefs().find(d => d.name === "vortex_file_upload")!;
    expect(upload.annotations?.destructiveHint).toBe(true);
    expect(upload.annotations?.openWorldHint).toBe(true);
  });

  it("non-destructive tools (e.g. vortex_extract) do NOT carry destructiveHint", () => {
    const extract = getToolDefs().find(d => d.name === "vortex_extract")!;
    expect(extract.annotations?.destructiveHint).toBeUndefined();
  });
});

// Bug F (v0.6.0 dogfood): PR #4 门面化把 vortex_observe schema 砍到 scope/filter，
// 漏掉 frames 参数。底层路由（server.ts spread rest, observe.ts:486 args.frames）
// 全部就位，但 LLM 看到的公开 schema 不暴露 → cross-origin iframe / SPA 嵌入场景
// 无从触发 all-permitted。本测试锁住 frames 暴露，防止门面收窄再次静默丢参数。
describe("Bug F regression: vortex_observe surface must expose frames", () => {
  const observe = getToolDefs().find(d => d.name === "vortex_observe")!;
  const props = (observe.schema as { properties: Record<string, any> }).properties;

  it("vortex_observe.schema.properties.frames exists", () => {
    expect(props.frames).toBeDefined();
  });

  // Strict equality (not arrayContaining) — guards against silent enum
  // drift in either direction: subset (capability removed) or superset
  // (untested value sneaked in). Order matches schemas.ts:111 internal enum.
  it("frames enum equals exactly main / all-same-origin / all-permitted / all", () => {
    expect(props.frames.enum).toEqual([
      "main",
      "all-same-origin",
      "all-permitted",
      "all",
    ]);
  });

  // The whole point of the description change is to nudge LLMs to switch
  // away from the implicit 'main' default when iframes are involved.
  // If a future edit drops the hint (e.g. reverts to "List interactive
  // elements in scope."), the schema-shape tests above still pass but
  // discoverability silently regresses — Bug F all over again.
  it("description hints frames usage for iframe contexts", () => {
    expect(observe.description).toMatch(/frames/);
  });
});
