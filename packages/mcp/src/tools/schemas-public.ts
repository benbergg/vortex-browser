// L4 public tool registry (v2.1: 17 tools)。
// spec: vortex重构-L4-spec.md §0.2.1 (compact schema rules)
//
// Compression rules (enforced by I15 ≤ 5200 B v2.1):
// - description: imperative, ≤ 60 chars
// - properties: NO description field
// - shared inline $defs not possible across tools (MCP serializes each)
//   so Target / TabRef structures are duplicated per tool
// - no `default` fields (handler defaults instead)
//
// v0.6 scope: target accepts ref string only (`@e3` / `@f1e2`) or null
// (whole page where applicable). Descriptor object form arrives in v0.6.x
// alongside L3 reasoning resolver — keeping schema honest with runtime.
//
// v0.8.x: hashed ref form `@<hash>:eN` / `@<hash>:fNeM` is preferred; bare
// `@eN` / `@fNeM` legacy refs remain accepted but deprecated in v0.9. The
// public description strings stay terse (≤ 60 char per I15) so ref-syntax
// guidance is carried by the internal `schemas.ts` tool descriptions.
//
// v2.1 PR-A: 从 v0.5 内部化回公开 2 个工具 + 2 段 description 文档化。
// 详见 tests/v2-shortboards.test.ts 端到端回归。
// 1. vortex_tab_list (P0-12) — handler 就绪,只差 schema 复制
// 2. vortex_history   (P1-13) — handler 就绪,只差 schema 复制
// 3. vortex_storage description (P1-14) — 文档化"omit key = list all"
// 4. vortex_evaluate description (P0-11) — 文档化"async=true 时 code 是 fn body"

import { COMMIT_KINDS } from "@vortex-browser/shared";
import type { ToolDef } from "./schemas.js";

const tabFields = {
  tabId: { type: "number" as const },
  frameId: { type: "number" as const },
};

// target: ref string only in v0.6 (`@e3` / `@f1e2` legacy + `@<hash>:eN`
// hashed form in v0.8.x). null variant lets extract/screenshot target the
// whole page; act/wait_for require a concrete element.
const TargetRequired = { type: "string" as const };
const TargetOptional = { oneOf: [{ type: "string" as const }, { type: "null" as const }] };

export const PUBLIC_TOOLS: ToolDef[] = [
  {
    name: "vortex_act",
    action: "L4.act",
    description: "Write to a UI element. scroll: value={container?,position}.",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        action: { enum: ["click", "fill", "type", "select", "scroll", "hover"] },
        value: {},
        useRealMouse: { type: "boolean" },
        options: {
          type: "object",
          properties: {
            timeout: { type: "number" },
            force: { type: "boolean" },
          },
        },
        ...tabFields,
      },
      required: ["target", "action"],
    },
  },
  {
    name: "vortex_observe",
    action: "L4.observe",
    description: "List interactive elements; iframes: frames=all-permitted.",
    schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["viewport", "full"] },
        filter: { enum: ["interactive", "all"] },
        frames: { enum: ["main", "all-same-origin", "all-permitted", "all"] },
        includeBoxes: { type: "boolean" },
        ...tabFields,
      },
    },
  },
  {
    name: "vortex_extract",
    action: "L4.extract",
    description: "Extract visible text. scroll=load lazy content first.",
    schema: {
      type: "object",
      properties: {
        target: TargetOptional,
        depth: { type: "number" },
        include: { type: "array", items: { enum: ["text", "value", "attrs"] } },
        scroll: { type: "boolean" },
        ...tabFields,
      },
    },
  },
  {
    name: "vortex_navigate",
    action: "page.navigate",
    description: "Navigate the active tab to a URL.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        waitUntil: { enum: ["load", "domcontentloaded", "networkidle"] },
        reload: { type: "boolean" },
        ...tabFields,
      },
      required: ["url"],
    },
  },
  {
    name: "vortex_tab_create",
    action: "tab.create",
    description: "Open a new browser tab.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        active: { type: "boolean" },
      },
    },
  },
  {
    name: "vortex_tab_close",
    action: "tab.close",
    description: "Close a browser tab.",
    schema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    // v2.1 PR-A (P0-12): 后端 tab.list handler 100% 就绪
    // (packages/extension/src/handlers/tab.ts:6-37),只差 schemas-public.ts 复制。
    // LLM agent 创建 tab 后用此工具拿到所有 tabId(active flag 必看),
    // 然后显式传 tabId 给 observe/act/evaluate 等操作非 active tab。
    name: "vortex_tab_list",
    action: "tab.list",
    description: "List open tabs with id, url, title, active flag.",
    schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "vortex_screenshot",
    action: "capture.screenshot",
    description: "Screenshot page/element. jpeg+quality saves tokens.",
    schema: {
      type: "object",
      properties: {
        target: TargetOptional,
        fullPage: { type: "boolean" },
        format: { enum: ["png", "jpeg"] },
        quality: { type: "number" },
        ...tabFields,
      },
    },
    returnsImage: true,
  },
  {
    name: "vortex_wait_for",
    action: "L4.wait_for",
    description: "Wait element/idle/info/custom(value=JS expr truthy).",
    schema: {
      type: "object",
      properties: {
        mode: { enum: ["element", "idle", "info", "custom"] },
        value: {},
        timeout: { type: "number" },
        ...tabFields,
      },
      required: ["mode"],
    },
  },
  {
    name: "vortex_press",
    action: "keyboard.press",
    description: "Press a key or shortcut globally.",
    schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        ...tabFields,
      },
      required: ["key"],
    },
  },
  {
    name: "vortex_debug_read",
    action: "L4.debug_read",
    description: "Read console or network logs.",
    schema: {
      type: "object",
      properties: {
        source: { enum: ["console", "network"] },
        filter: { type: "object" },
        tail: { type: "number" },
        ...tabFields,
      },
      required: ["source"],
    },
  },
  {
    // v2.1 PR-A (P1-13): 后端 page.back / page.forward handler 100% 就绪
    // (packages/extension/src/handlers/page.ts:212-226),dispatcher 也已
    // 写好方向路由(dispatch.ts:44-47),只差 schemas-public.ts 复制。
    // LLM agent 走 A→B→back 比重发 navigate 省一次完整网络请求。
    // action 写 page.back 是占位:dispatcher 在 case "vortex_history" 中
    // 按 direction 重新路由到 page.back 或 page.forward。
    name: "vortex_history",
    action: "page.back",
    description: "Browser back/forward. direction=back (default)|forward.",
    schema: {
      type: "object",
      properties: {
        direction: { enum: ["back", "forward"] },
        ...tabFields,
      },
    },
  },
  {
    // v2.1 PR-A (P1-14): 描述文档化。v2.2 实测确认 vortex_storage op:get
    // 不传 key 实测返回所有 key-value 完整对象(handler storage.ts:80-107),
    // 真正的"能力缺口"是 LLM 不知道 omit key = list all。
    name: "vortex_storage",
    action: "L4.storage",
    description: "local/session/cookies CRUD. omit key = list all.",
    schema: {
      type: "object",
      properties: {
        op: { enum: ["get", "set", "session-get", "session-set", "cookies-get"] },
        key: { type: "string" },
        value: {},
        ...tabFields,
      },
      required: ["op"],
    },
  },
  {
    // v2.1 PR-A (P0-11): 描述文档化。v2.2 实测确认:
    //   - sync 模式 code 是表达式,直接返回求值结果
    //   - async=true 时 code 是 async 函数体,必须含 return
    //   - 未调用的箭头/function 表达式和 async IIFE 形式均会返回 undefined
    //     (handler 序列化函数/NodeList 为 undefined)
    // LLM 写"返回 JSON"写法时需用 JSON.stringify() / 直接 return 兜底。
    name: "vortex_evaluate",
    action: "js.evaluate",
    description: "Execute JS. async=true: code is fn body, return obj.",
    schema: {
      type: "object",
      properties: {
        code: { type: "string" },
        async: { type: "boolean" },
        ...tabFields,
      },
      required: ["code"],
    },
    // Arbitrary JS in MAIN world (sees page globals, can read cookies via fetch).
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "vortex_mouse_drag",
    action: "mouse.drag",
    description: "CDP drag (fromX,fromY)→(toX,toY). steps default 10.",
    schema: {
      type: "object",
      properties: {
        fromX: { type: "number" },
        fromY: { type: "number" },
        toX: { type: "number" },
        toY: { type: "number" },
        steps: { type: "number" },
        coordSpace: { enum: ["frame", "viewport"] },
        ...tabFields,
      },
      required: ["fromX", "fromY", "toX", "toY"],
    },
  },
  {
    name: "vortex_file_upload",
    action: "file.upload",
    description: "Upload to input[type=file]. fileContent base64.",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        fileName: { type: "string" },
        fileContent: { type: "string" },
        mimeType: { type: "string" },
        ...tabFields,
      },
      required: ["selector", "fileName", "fileContent"],
    },
    // Submits attacker-chosen bytes to whatever endpoint the page form posts to.
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "vortex_fill",
    action: "L4.fill",
    description: "Fill form field; kind=cascader/select/daterange for widgets.",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        value: {},
        kind: { enum: [...COMMIT_KINDS] },
        ...tabFields,
      },
      required: ["target", "value"],
    },
  },
];

export function getPublicToolDefs(): ToolDef[] {
  return PUBLIC_TOOLS;
}
