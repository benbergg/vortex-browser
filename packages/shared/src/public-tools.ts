/**
 * Description: Single source of truth for the public MCP tool names.
 */

// hint 引用的工具名必须在此表内,否则指引 LLM 去调一个 tools/list 拿不到的工具。
// 表曾被手抄进 I20 并冻结在 v0.6 的 11 个,把 tab-gone 的正确指引逼成了错的
// (2026-08-19)。改动 schemas-public.ts 的工具集时,mcp 的漂移用例会先红。
export const PUBLIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "vortex_act",
  "vortex_observe",
  "vortex_extract",
  "vortex_navigate",
  "vortex_tab_create",
  "vortex_tab_close",
  "vortex_tab_list",
  "vortex_browser",
  "vortex_screenshot",
  "vortex_sequence",
  "vortex_resize",
  "vortex_wait_for",
  "vortex_press",
  "vortex_debug_read",
  "vortex_history",
  "vortex_storage",
  "vortex_evaluate",
  "vortex_drag",
  "vortex_mouse_drag",
  "vortex_mouse_click",
  "vortex_file_upload",
  "vortex_fill",
  "vortex_query",
  "vortex_fill_form",
]);
