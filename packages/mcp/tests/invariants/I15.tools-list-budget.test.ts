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
//
// v3.3 PR-redesign: 5300 → 5500 B,description 60 → 120 char。
// (1) B3-2 vortex_storage 加 list-keys/-all 公开能力,description 重写
//     "list-keys/-all for ls summary."(54 char,在原 60 之内,无 schema 变化)。
// (2) B3-6 vortex_press description 加 scrolling 引导(window.scrollTo 替代
//     key:End)+ 无聚焦元素提示(40 → 114 char)。B3-6 是 P0 体验断点,根因
//     是 body 无 tabindex,提示 LLM 改用 evaluate scrollTo 是真修复。cap
//     同步放宽 (+200B, +60 char),沿用历次"加能力微调 cap 不压缩字符"惯例。
//
// V4 PR-REQ-009 (f577b04): 5500 → 5600 B,description 56 → 112 char。
// vortex_evaluate description 加 IIFE 模板示例 (function(){return 42;})() /
// (async function(){...})(),让 LLM 一次看明白箭头/function 必须 IIFE 包裹
// (vortex_evaluate 用 JSON-RPC 传输 code 字符串,箭头/function 顶层表达式
// 无法 standalone 求值,IIFE 才能成 statement)。新 payload 实测 5506 B,
// cap +100 至 5600 留 94 B 余量,沿用"加能力微调 cap 不压缩字符"惯例。
// description 长度上限同步放宽 60 → 120 (vortex-evaluate-description.test.ts
// 镜像此决策)。
//
// feat/dialog-handling (修正版): 5800 → 6000 B。vortex_act options 新增
// onDialog(enum) + promptText(string) 两个弹窗应答字段 (+84B schema),
// vortex_act description 恢复载荷性 hint (windowMs上限3000,慢站0网络≠失败
// + click observeEffect→effect signals),并追加 onDialog clause。
// 恢复后 description 174 char,schema 字段 +84B,payload 实测 5918B。
// cap +200 至 6000,留 82B 余量。description 长度上限同步放宽 120 → 180
// (沿用"加能力微调 cap 不压缩字符"惯例；174 char = 120 原始 + 54 onDialog子句)。

import { describe, it, expect } from "vitest";
import { COMMIT_KINDS } from "@vortex-browser/shared";
import { getToolDefs, getInternalToolDef } from "../../src/tools/registry.js";

describe("I15: tools/list budget + count + internalized grep", () => {
  const defs = getToolDefs();
  const toolsListPayload = JSON.stringify(
    defs.map(d => ({ name: d.name, description: d.description, inputSchema: d.schema })),
  );

  it("tools/list 字节 ≤ 6000 B (dialog-handling onDialog/promptText +84B schema + 恢复 vortex_act description, 实测 5918 留 82B buffer)", () => {
    // V2 P0 修复 D16: filter 子字段 description 是必要的文档化豁免
    // (handler 已实现 console.ts:160 level / network.ts:305-321 pattern+statusMin/Max),
    // 移除豁免会触发 V2 D16 真发现复发 (LLM 不知可用子字段)。
    // 上限 6000 = 5800 (上轮基线) + 200 (onDialog/promptText 真新增能力豁免
    // + vortex_act description 恢复载荷性 hint，实测 5918B，留 82B 余量)。
    expect(toolsListPayload.length).toBeLessThanOrEqual(6000);
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

  it("description 长度 ≤ 180 char", () => {
    // 120 → 180: vortex_act description 恢复原始 hint + 追加 onDialog clause = 174 char。
    // 174 = 120 原始 + 54 onDialog 子句，是真新增能力驱动的增长。
    for (const d of defs) {
      expect(d.description.length).toBeLessThanOrEqual(180);
    }
  });

  it("inputSchema 中 properties 字段不带 description（节字节）", () => {
    // I15 §0.2.1: 顶层 property 不带 description (节字节)。
    // V2 P0 修复 D16 豁免: vortex_debug_read.filter 是 handler 已实现的子字段
    // (console.ts:160 level / network.ts:305-321 pattern+statusMin/Max), 必须
    // 文档化让 LLM 知道可用。filter.description 是单点豁免 (1 个 description
    // 共 ~150 字符, 远低于 94 B buffer 损耗)。
    const FILTER_DOC_OVERHEAD: Record<string, number> = {
      "vortex_debug_read": 200, // filter.description 字节豁免
    };
    function checkNoPropertyDescription(schema: any, path = "", toolName = ""): void {
      if (!schema || typeof schema !== "object") return;
      if (schema.properties && typeof schema.properties === "object") {
        for (const [k, v] of Object.entries(schema.properties)) {
          if (v && typeof v === "object" && "description" in (v as object)) {
            // V2 P0 修复 D16 豁免: 仅 vortex_debug_read.filter 允许 description
            if (toolName === "vortex_debug_read" && k === "filter" &&
                FILTER_DOC_OVERHEAD["vortex_debug_read"] > 0) {
              // 豁免通过 (FILTER_DOC_OVERHEAD 标记)
            } else {
              throw new Error(`${path}.properties.${k} has description (forbidden by §0.2.1)`);
            }
          }
          checkNoPropertyDescription(v, `${path}.properties.${k}`, toolName);
        }
      }
      if (schema.items) checkNoPropertyDescription(schema.items, `${path}.items`, toolName);
      if (schema.oneOf) for (const o of schema.oneOf) checkNoPropertyDescription(o, `${path}.oneOf`, toolName);
    }
    for (const d of defs) {
      expect(() => checkNoPropertyDescription(d.schema, "", d.name)).not.toThrow();
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
