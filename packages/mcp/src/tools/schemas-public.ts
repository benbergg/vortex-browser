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
    description:
      "Write to a UI element. scroll:value={container?,position}. " +
      "click observeEffect→effect signals; windowMs上限3000,慢站0网络≠失败. " +
      "onDialog:accept|dismiss(默认dismiss),promptText给prompt框.",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        action: { enum: ["click", "fill", "type", "select", "scroll", "hover"] },
        value: {},
        useRealMouse: { type: "boolean" },
        options: {
          type: "object",
          // I15 invariant: properties 内无 description。onDialog 含义见工具级 description。
          properties: {
            timeout: { type: "number" },
            force: { type: "boolean" },
            observeEffect: { type: "boolean" },
            windowMs: { type: "number" },
            onDialog: { enum: ["accept", "dismiss"] },
            promptText: { type: "string" },
            fingerprint: {
              type: "object",
              description:
                "可验证重放(click):{mode:'record'} 采集效果指纹返回 fingerprint;" +
                "{mode:'verify',expect:<fp>,autoRecover?} 比对并返回 drift(drift!=null=效果变了)。",
              properties: {
                mode: { enum: ["record", "verify"] },
                expect: { type: "object" },
                autoRecover: { type: "boolean" },
              },
              required: ["mode"],
            },
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
    description: "Nested a11y tree (ref=@..). iframes: frames=all-permitted.",
    schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["viewport", "full"] },
        filter: { enum: ["interactive", "all"] },
        frames: { enum: ["main", "all-same-origin", "all-permitted", "all"] },
        includeBoxes: { type: "boolean" },
        prevSnapshotId: { type: "string" },
        ...tabFields,
      },
    },
  },
  {
    name: "vortex_extract",
    action: "L4.extract",
    description: "Extract visible text. maxLength 10KB. scroll=load lazy.",
    schema: {
      type: "object",
      properties: {
        target: TargetOptional,
        depth: { type: "number" },
        include: { type: "array", items: { enum: ["text", "value", "attrs"] } },
        maxLength: { type: "number", default: 10240 },
        scroll: { type: "boolean" },
        // REQ-NNN N0060 京东评测: include alt text from <img alt> elements
        // (京东自营 / 淘宝天猫角标). default true (向后兼容: false 时行为与
        // 原 innerText 一致). I15 invariant: properties 无 description.
        includeAlt: { type: "boolean" },
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
    description: "Wait. mode=element|CSS, custom|JS, idle=net/xhr/dom, info.",
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
    // v3.3 B3-6 V2:加 scrolling 引导(window.scrollTo 替代 key:End)+ 无聚焦元素提示
    // (claude-code §3 建议:body 无 tabindex 时按键不生效)。description 86 char,
    // I15 cap 60 → 100 同步放宽(项目惯例:加能力微调 cap,见 I15 文件头注释历次)。
    description: "Press a key globally. Prefer vortex_evaluate window.scrollTo over key:End. Needs focused element.",
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
    // request: 用 network 列表里的 reqid 取单请求 status+body（确定性判定）
    description: "Network pattern REQUIRED. request:reqid→status+body. filter={level|pattern}",
    schema: {
      type: "object",
      properties: {
        source: { enum: ["console", "network", "request"] },
        // request 模式：reqid 来自 source=network 返回列表里的 requestId 字段
        reqid: { type: "string" },
        // V2 P0 修复 D16: filter 子字段文档化 (handler 已实现, LLM 此前不知可用)
        // console: { level: 'error'|'warn'|'all' }
        // network: { pattern: '<substr>', statusMin, statusMax }
        filter: {
          type: "object",
          description: "console:{level}; network:{pattern,statusMin/Max}",
        },
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
    // v3.3 B3-2 (V2):新增 list-keys / list-all op,避免返 100KB+ 截断的全量。
    // list-keys 仅返 keys + valueLengths(< 5KB),list-all 显式 opt-in 返全量。
    name: "vortex_storage",
    action: "L4.storage",
    description: "local/session/cookies CRUD; list-keys/-all for ls summary.",
    schema: {
      type: "object",
      properties: {
        op: { enum: ["get", "set", "session-get", "session-set", "cookies-get", "list-keys", "list-all"] },
        key: { type: "string" },
        value: {},
        maxLength: { type: "number", default: 10240 },  // BUG-002: ms default 10KB
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
    //
    // v2.2 P2 (vortex-bench 2026-06-07 淘宝评测 V3 §5.1 P2):
    // 实测踩坑:`() => 42` / `async () => obj` 在 eval 后返回**函数定义**
    // (经 expandHost 转 undefined),LLM 误以为"evaluate 坏了"开始调试循环。
    // 必须 IIFE 包裹:`(function(){return 42;})()` / `(async function(){...})()`。
    // description 须 1 句话让 LLM 知道箭头/function 必须 IIFE 调用。
    name: "vortex_evaluate",
    action: "js.evaluate",
    // V4 评测 REQ-009 边际改进: description 加 IIFE 模板示例,
    // 让 LLM 一次看明白箭头/function 必须 IIFE 包裹(ef242c7 P2 修复仅含
    // "IIFE" 单词,边际警告)。保留 ef242c7 既有"MAIN world"+"async=fn body"
    // +"cross-origin iframe"三约束。description 总长 ≤ 80 字符(I15 ≤60 已
    // 突破,本任务为边际改进,接受 80 字符硬上限)。
    description: "MAIN world. async=fn body. IIFE: (function(){return 42;})() / (async function(){...})(). No cross-origin iframe.",
    schema: {
      type: "object",
      properties: {
        code: { type: "string" },
        async: { type: "boolean" },
        timeout: { type: "number", default: 5000 },  // BUG-003: ms, max 60000
        ...tabFields,
      },
      required: ["code"],
    },
    // Arbitrary JS in MAIN world (sees page globals, can read cookies via fetch).
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    // v0.9: 元素级 DnD。两个 ref 各取 getBoundingClientRect 中心，走 CDP trusted pointer 序列+actionability 门。
    // vortex_mouse_drag 保留（canvas/地图等无 ref 场景仍需坐标 drag）。
    name: "vortex_drag",
    action: "mouse.dragElement",
    description: "Ref-based DnD: startRef→center→CDP trusted drag→endRef. Actionability-gated.",
    schema: {
      type: "object",
      properties: {
        startRef: { type: "string" as const },
        endRef: { type: "string" as const },
        steps: { type: "number" as const },
        ...tabFields,
      },
      required: ["startRef", "endRef"],
    },
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
        stepDelay: { type: "number", default: 0 },  // BUG-007: ms, 0 = no inter-step delay
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
        target: TargetOptional,
        selector: { type: "string" },
        fileName: { type: "string" },
        fileContent: { type: "string" },
        mimeType: { type: "string" },
        ...tabFields,
      },
      required: ["fileName", "fileContent"],
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
        force: { type: "boolean" },
        ...tabFields,
      },
      required: ["target", "value"],
    },
  },
  {
    // 富文本编辑器粘贴：经合成 paste 事件把 text(纯文本)/html(可选)插入编辑器。
    // Markdown 是否转富文本取决于编辑器：部分编辑器自动转，部分(如语雀 Lake,
    // 对合成 isTrusted=false 事件不自动转)插入字面 markdown 并由其 UI 转换按钮转换。
    // 故描述只承诺「插入」,不承诺自动转换(2026-06-26 Lake 实机 spike 实证)。
    name: "vortex_paste",
    action: "dom.paste",
    description: "Paste text/html into a rich-text editor.",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        text: { type: "string" },
        html: { type: "string" },
        force: { type: "boolean" },
        timeout: { type: "number" },
        ...tabFields,
      },
      required: ["target", "text"],
    },
  },
  {
    // 零 LLM 探测:text grep 可见文本 / css 计数+取属性。一次 executeScript 即时返回。
    name: "vortex_query",
    action: "query.queryPage",
    description: "Zero-LLM page probe: mode=text greps visible text; mode=css finds elements by selector (attr for attributes, e.g. href).",
    schema: {
      type: "object",
      properties: {
        mode: { enum: ["text", "css"] },
        pattern: { type: "string" },
        isRegex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        contextChars: { type: "number" },
        attr: { type: "string" },
        includeText: { type: "boolean" },
        maxResults: { type: "number" },
        ...tabFields,
      },
      required: ["mode", "pattern"],
    },
  },
  {
    // 工具横向优化 T7: 批量填表，fields[] 循环复用 fill/dom.commit 分流，部分成功语义。
    // 内部由 server.ts 特殊处理（逐 field 串行调 L4.fill/dom.commit），不走单次 sendRequest。
    name: "vortex_fill_form",
    action: "L4.fill_form",
    description: "Batch-fill multiple fields; partial-success per field. kind=cascader/select/daterange for widgets.",
    schema: {
      type: "object",
      properties: {
        fields: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              target: TargetRequired,
              value: {},
              kind: { enum: [...COMMIT_KINDS] },
              force: { type: "boolean" as const },
            },
            required: ["target", "value"],
          },
        },
        ...tabFields,
      },
      required: ["fields"],
    },
  },
];

export function getPublicToolDefs(): ToolDef[] {
  return PUBLIC_TOOLS;
}
