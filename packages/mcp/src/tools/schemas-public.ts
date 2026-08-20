// L4 public tool registry (v2.1: 17 tools)。
// spec: vortex重构-L4-spec.md §0.2.1 (compact schema rules)
//
// Compression rules (enforced by I15):
// - description: imperative, ≤ 60 chars
// - properties: description 仅给"模型会填错或不知道能填什么"的参数
//   (2026-08-09 工具选择评测修订: 原规则是一律不写。实测 113 个参数只有 2 个
//    有说明,模型在公开站点任务上 4/4 改用 playwright——尽管 vortex 全能做到。
//    典型代价: screenshot 因 target 无说明多花一倍调用。详见
//    reports/_eval/tool-choice-2026-08-09.md。tabId/frameId 等自解释参数仍不写。)
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

import { COMMIT_KINDS, MAX_INNER_TIMEOUT_MS } from "@vortex-browser/shared";
import type { ToolDef } from "./schemas.js";

const tabFields = {
  tabId: { type: "number" as const },
  frameId: { type: "number" as const },
};

// target: ref string only in v0.6 (`@e3` / `@f1e2` legacy + `@<hash>:eN`
// hashed form in v0.8.x). null variant lets extract/screenshot target the
// whole page; act/wait_for require a concrete element.
const TargetRequired = {
  type: "string" as const,
  description: "@ref from vortex_observe, or a CSS selector",
};
const TargetOptional = {
  oneOf: [{ type: "string" as const }, { type: "null" as const }],
  description: "@ref from vortex_observe, or a CSS selector; null/omit = whole page",
};

export const PUBLIC_TOOLS: ToolDef[] = [
  {
    name: "vortex_act",
    action: "L4.act",
    description:
      "Write to a UI element. scroll:value={container?,position}; target=@ref scrolls that element itself. " +
      "click observeEffect→effect signals; windowMs上限3000,慢站0网络≠失败. " +
      "onDialog:accept|dismiss(默认dismiss),promptText给prompt框.",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        action: { enum: ["click", "fill", "type", "select", "scroll", "hover"] },
        value: { description: "click/hover: omit; fill/type/select: string; scroll: {container?,position}" },
        useRealMouse: { type: "boolean" },
        options: {
          type: "object",
          // onDialog 含义见工具级 description
          properties: {
            timeout: { type: "number", maximum: MAX_INNER_TIMEOUT_MS },
            force: { type: "boolean" },
            observeEffect: { type: "boolean" },
            windowMs: { type: "number" },
            onDialog: { enum: ["accept", "dismiss"] },
            promptText: { type: "string" },
            fingerprint: {
              type: "object",
              description:
                "可验证重放(click/fill/type/select/scroll):{mode:'record'} 采集效果指纹返回 fingerprint;" +
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
        maxLength: { type: "number", default: 10240, description: "default 10240; longer text is cut with a [VORTEX_TRUNCATED] marker" },
        scroll: { type: "boolean" },
        // REQ-NNN N0060 京东评测: include alt text from <img alt> elements
        // (京东自营 / 淘宝天猫角标). default true (向后兼容: false 时行为与
        // 原 innerText 一致).
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
    // 无参=列出在线浏览器与当前绑定；带 browser=切到该浏览器
    name: "vortex_browser",
    action: "browser.list",
    description: "List online browsers and current binding; pass browser (e.g. chrome/edge) to switch.",
    schema: {
      type: "object",
      properties: { browser: { type: "string" } },
      required: [],
    },
  },
  {
    name: "vortex_screenshot",
    action: "capture.screenshot",
    description: "Screenshot page/element. jpeg+quality saves tokens. marks=overlay observe ref# on viewport (pixel→@ref).",
    schema: {
      type: "object",
      properties: {
        target: TargetOptional,
        fullPage: { type: "boolean" },
        format: { enum: ["png", "jpeg"] },
        quality: { type: "number" },
        // P1-3 薄视觉兑底(Set-of-Mark):把最近 observe 的 ref 编号叠到视口截图上,
        // 图上数字=快照 index=@ref。仅视口(非 fullPage/元素)。snapshotId 指定用哪次
        // observe 的编号,省略则该 tab 最近一次。
        marks: { type: "boolean" },
        snapshotId: { type: "string" },
        ...tabFields,
      },
    },
    returnsImage: true,
  },
  {
    name: "vortex_sequence",
    action: "L4.sequence",
    description:
      "Run multiple actions in one call, each self-verified before the next. " +
      "Per-step state: not_executed|executed_unverified|executed_verified|failed.",
    schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { enum: ["click", "fill", "type", "select", "scroll", "hover"] },
              target: TargetRequired,
              value: { description: "same as vortex_act: fill/type/select string; scroll {container?,position}" },
            },
            required: ["action", "target"],
          },
        },
        onFailure: { enum: ["stop", "continue"], description: "default stop" },
        tabId: { type: "number" },
      },
      required: ["steps"],
    },
  },
  {
    name: "vortex_resize",
    action: "page.setViewport",
    description: "Emulate viewport size for responsive checks (DevTools device mode; real window untouched). reset=true restores.",
    schema: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
        deviceScaleFactor: { type: "number" },
        mobile: { type: "boolean" },
        reset: { type: "boolean" },
        ...tabFields,
      },
    },
  },
  {
    name: "vortex_wait_for",
    action: "L4.wait_for",
    description: "Wait. mode=element|CSS, custom|JS, idle=net/xhr/dom, info.",
    schema: {
      type: "object",
      properties: {
        mode: { enum: ["element", "idle", "info", "custom"] },
        value: { description: "element: CSS selector; custom: JS expression; idle: net|xhr|dom; info: omit" },
        timeout: { type: "number", maximum: MAX_INNER_TIMEOUT_MS },
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
    // B2: 点明 network/request 自动捕获 POST 请求/响应体,消除"手搓 fetch hook"误用根因
    // B3-8: 保留 "pattern REQUIRED" 提示(避免 LLM 拉全量网络日志,network-debug-read-limit 测)
    description: "Read console/network. network pattern REQUIRED; auto-captures POST req+resp bodies (no fetch hook); request: reqid→status+headers+reqBody+respBody.",
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
          description: "flat keys, do not nest by source: {level} for console; {pattern,statusMin,statusMax} for network",
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
        // 上限只写在注释里时,调用方看不到,实测有传 120000 被 extension 打回的
        timeout: { type: "number", default: 5000, maximum: MAX_INNER_TIMEOUT_MS },
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
    // canvas/地图等无 ref 场景的坐标点击。handler(mouse.click)早已实现(含 frame→viewport
    // 换算),此前只暴露了坐标版 mouse.drag 未暴露 click,导致 canvas 单元格只能"点中心+方向键"绕。
    // 命名与坐标版 vortex_mouse_drag 配对(均 CDP 坐标派发),区别于 ref 版 vortex_act click。
    name: "vortex_mouse_click",
    action: "mouse.click",
    description: "CDP click at (x,y). canvas/no-ref. coordSpace=frame→viewport by frameId.",
    schema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { enum: ["left", "right", "middle"] },
        coordSpace: { enum: ["frame", "viewport"] },
        ...tabFields,
      },
      required: ["x", "y"],
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
    description: "Fill field; widget=cascader/select/daterange for widgets.",
    schema: {
      type: "object",
      properties: {
        target: TargetRequired,
        value: { description: "plain input: string; daterange/datetimerange: {start,end}; cascader: path array" },
        widget: { enum: [...COMMIT_KINDS] },
        force: { type: "boolean" },
        ...tabFields,
      },
      required: ["target", "value"],
    },
  },
  {
    // 零 LLM 探测:text grep 可见文本 / css 计数+取属性。一次 executeScript 即时返回。
    name: "vortex_query",
    action: "query.queryPage",
    description: "Zero-LLM probe: text=grep; css=find elems; component=Vue/React state; elements=几何+文本+样式一次拿全(dimensions 选维度); geometry=bbox/clip/occlude; style=排版/盒/绘制/动效/伪元素/实际渲染字体+WCAG(attr 选组); sheet=Lake Sheet→md/csv/json; flow=流程图→mermaid; chart=echarts→数据(attr=summary|json); tokens=CSS 变量→调色板/字阶(pattern=*,只扫 :root/body).",
    schema: {
      type: "object",
      properties: {
        mode: {
          enum: ["text", "css", "component", "elements", "geometry", "style", "sheet", "flow", "chart", "schema", "tokens"],
          description:
            "component reads Vue/React instance state; sheet only reads Yuque Lake Sheet, NOT DOM tables (use extract for those); " +
            "schema=author-declared JSON-LD/Microdata/OGP (pattern=@type or '*'), may differ from visible content; " +
            "css/component/geometry/style 的 pattern 也接受 vortex_observe 给的 @ref",
        },
        pattern: { type: "string" },
        dimensions: {
          type: "string",
          description: "mode=elements 专用,逗号或竖线分隔,默认 geometry,text: geometry|text|attrs|contrast|typography|box|paint|motion|pseudo|font; 返回体 dimensions.<名>.available 自陈这一维是否真拿到",
        },
        isRegex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        contextChars: { type: "number" },
        attr: { type: "string", description: "css: 属性名, 多个用 , 或 | 分隔(如 'class|title'); style: 分组 typography|box|paint|motion|pseudo|font(默认全开;font 用 CDP 报实际渲染字体,需 debugger); chart/sheet/flow: 输出格式" },
        includeText: { type: "boolean" },
        maxResults: {
          type: "number",
          minimum: 1,
          maximum: 2000,
          description: "各 mode 上限不同(chart 2000/sheet 1000/tokens 200/元素类 50),超出按 mode 截断; tokens 是每组上限(默认40),其他是元素数上限(默认10)",
        },
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
    description: "Batch-fill multiple fields; partial-success per field. widget=cascader/select/daterange for composite widgets.",
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
              widget: { enum: [...COMMIT_KINDS] },
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
