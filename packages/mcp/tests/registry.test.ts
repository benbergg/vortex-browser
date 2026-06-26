import { describe, it, expect } from "vitest";
import { getToolDefs, getToolDef, getInternalToolDef } from "../src/tools/registry.js";
import { getAllToolDefs } from "../src/tools/schemas.js";

describe("getToolDefs", () => {
  it("returns a non-empty array", () => {
    const defs = getToolDefs();
    expect(defs.length).toBeGreaterThan(0);
  });

  it("returns a fresh copy each time (not same array reference)", () => {
    const a = getToolDefs();
    const b = getToolDefs();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("returns 21 public tools (vortex_paste 新增: 20 + vortex_paste)", () => {
    // v2.1 PR-A: 把 v0.5 内部化的 vortex_tab_list + vortex_history
    // promote 回 public（spec 12-Projects/0000-vortex优化/v2.1-实施方案.md §2 §3）。
    // 后端 handler 早就 ready,只是 schemas-public.ts 没复制 schema 块。
    // 工具横向优化 T6: 新增 vortex_drag(元素级 DnD, action=mouse.dragElement)。
    // 工具横向优化 T7: 新增 vortex_fill_form(fields[] 批量填表, 部分成功语义)。
    // 工具横向优化: 新增 vortex_query(零 LLM 探测, text grep + css find)。
    // vortex_paste 新增(target+text+html+force, action=dom.paste)。
    const names = getToolDefs().map((d) => d.name);
    expect(names.sort()).toEqual([
      "vortex_act",
      "vortex_debug_read",
      "vortex_drag",
      "vortex_evaluate",
      "vortex_extract",
      "vortex_file_upload",
      "vortex_fill",
      "vortex_fill_form",
      "vortex_history",
      "vortex_mouse_drag",
      "vortex_navigate",
      "vortex_observe",
      "vortex_paste",
      "vortex_press",
      "vortex_query",
      "vortex_screenshot",
      "vortex_storage",
      "vortex_tab_close",
      "vortex_tab_create",
      "vortex_tab_list",
      "vortex_wait_for",
    ]);
  });

  it("v0.5 internalized tools are accessible via getInternalToolDef but not getToolDef", () => {
    // v0.5 36 个 atom 中 25 个内部化（保留实现供 L4 dispatch 调）。
    // v0.8 把 fill / evaluate / mouse_drag / file_upload 4 个 promote 回公开，
    // v2.1 PR-A 又把 tab_list / history promote 回公开,共 17 public + 23 internal。
    const internalized = [
      "vortex_click", "vortex_type", "vortex_select", "vortex_hover", "vortex_batch",
      "vortex_get_text", "vortex_get_html",
      "vortex_mouse_click", "vortex_mouse_move",
      "vortex_console", "vortex_network", "vortex_network_response_body",
      "vortex_storage_get", "vortex_storage_set", "vortex_storage_session",
      "vortex_frames_list", "vortex_wait", "vortex_wait_idle",
      "vortex_page_info",
      "vortex_file_download", "vortex_file_list_downloads",
      "vortex_events", "vortex_ping",
    ];
    for (const n of internalized) {
      expect(getToolDef(n), `${n} should NOT be in public registry`).toBeUndefined();
      expect(getInternalToolDef(n), `${n} should still be in internal map`).toBeDefined();
    }
  });

  it("each tool has name, action, description, and schema", () => {
    for (const def of getToolDefs()) {
      expect(def.name).toMatch(/^vortex_/);
      expect(def.action).toBeTruthy();
      expect(typeof def.action).toBe("string");
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.schema).toBeTruthy();
    }
  });

  it("tool names are unique (no duplicates)", () => {
    const names = getToolDefs().map((d) => d.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("all tool actions map back to a valid tool name", () => {
    for (const def of getToolDefs()) {
      expect(getToolDef(def.name)).toBeDefined();
      expect(getToolDef(def.name)?.action).toBe(def.action);
    }
  });

  it("image-returning tools are marked with returnsImage=true", () => {
    const screenshot = getToolDef("vortex_screenshot");
    expect(screenshot?.returnsImage).toBe(true);
  });

  it("non-image tools do not have returnsImage flag", () => {
    const navigate = getToolDef("vortex_navigate");
    expect(navigate?.returnsImage).toBeUndefined();
  });

  it("has exactly 21 public tools (vortex_paste 新增: 20 + vortex_paste)", () => {
    // v2.1 PR-A 工作量 ≤ 0.3 人天:schemas-public.ts 复制 2 个 schema 块 +
    // 2 段 description 改写,后端零代码改动。
    // 工具横向优化 T7: 新增 vortex_fill_form(fields[] 批量填表, 部分成功语义)。
    // 工具横向优化: 新增 vortex_query(零 LLM 探测, text grep + css find)。
    // vortex_paste 新增(target+text+html+force, action=dom.paste)。
    expect(getToolDefs().length).toBe(21);
  });
});

describe("getToolDef (public)", () => {
  it("returns public tool def by exact name", () => {
    const def = getToolDef("vortex_act");
    expect(def).toBeDefined();
    expect(def!.name).toBe("vortex_act");
    expect(def!.action).toBe("L4.act");
  });

  it("returns undefined for unknown tool name", () => {
    expect(getToolDef("vortex_nonexistent")).toBeUndefined();
    expect(getToolDef("")).toBeUndefined();
    expect(getToolDef("vortex_")).toBeUndefined();
  });

  it("internal tools (vortex_events / vortex_ping) reachable via getInternalToolDef", () => {
    expect(getInternalToolDef("vortex_events")?.action).toBe("__mcp_events__");
    expect(getInternalToolDef("vortex_ping")?.action).toBe("__mcp_ping__");
  });

  it("schema inputSchema is valid JSON Schema object", () => {
    const def = getToolDef("vortex_navigate");
    expect(def?.schema).toHaveProperty("type", "object");
    expect(def?.schema).toHaveProperty("properties");
    expect(def?.schema).toHaveProperty("required");
  });
});