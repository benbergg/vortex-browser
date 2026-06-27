// packages/mcp/src/tools/schemas.ts

import { COMMIT_KINDS } from "@vortex-browser/shared";

/**
 * MCP 2025-03-26+ tool annotations. Optional behavioural hints that
 * LLM clients (Claude Code, Cursor, …) use to gate destructive / open-world
 * tools with stricter user approval prompts.
 *
 * Set destructiveHint:true for tools that mutate user-visible state in ways
 * the user cannot trivially undo (vortex_evaluate runs arbitrary JS in MAIN
 * world; vortex_file_upload submits attacker-chosen bytes to logged-in target).
 * Set openWorldHint:true when the tool interacts with the open web rather
 * than a confined sandbox.
 */
export interface ToolAnnotations {
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolDef {
  name: string;
  action: string;
  description: string;
  schema: object;
  returnsImage?: boolean;
  annotations?: ToolAnnotations;
  /**
   * caps opt-in 标记。带 cap 的工具默认**不**进 public 面（不在 tools/list），
   * 仅当 server 启动时经 `--caps=<cap>` 显式启用、且 cap ∈ enabledCaps 时，
   * 才被 registry 提升进 getToolDefs/getToolDef 返回结果。
   * 例：vortex_verify cap:"testing" —— 仅 `--caps=testing` 时对外可见。
   */
  cap?: string;
}

const optionalTabId = {
  tabId: { type: "number" as const, description: "Tab ID (omit = active tab)." },
};

const optionalFrameRef = {
  frameRef: {
    type: "string" as const,
    description: "`@fN` frame ref (omit = main frame).",
  },
};

const optionalFrameId = {
  frameId: { type: "number" as const, description: "Frame ID for iframes." },
};

const targetRef = {
  target: {
    type: "string" as const,
    description:
      "`@<hash>:eN` / `@<hash>:fNeM` ref or CSS selector (bare `@eN` / `@fNeM` accepted in v0.8.x; deprecated in v0.9).",
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// 诊断 & 事件（3 个）
// ──────────────────────────────────────────────────────────────────────────────

function diagnosticsTools(): ToolDef[] {
  return [
    {
      name: "vortex_ping",
      action: "__mcp_ping__",
      description: "Call FIRST. Returns mcpVersion, extensionVersion, schemaHash, toolCount, tabCount.",
      schema: { type: "object", properties: {}, required: [] },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Dev（1 个，cap:"dev" opt-in）—— 仅本地联调/评测用，绝不进 prod 用户面
// ──────────────────────────────────────────────────────────────────────────────

function devTools(): ToolDef[] {
  return [
    {
      name: "vortex_dev_reload",
      action: "__mcp_dev_reload__",
      // dev cap 工具：经 --caps=dev 提升。改完扩展代码 + rebuild 后调一次,
      // 触发 chrome.runtime.reload() 并轮询 diagnostics.version 的 buildStamp,
      // 直到戳变化(= 新 dist 已生效)才返回——让评测回合永不对旧代码跑测。
      description:
        "DEV ONLY (cap:dev). After rebuilding the extension, reload it in Chrome and verify " +
        "the new build is live before continuing. Triggers chrome.runtime.reload() via the " +
        "server, then polls until the extension's buildStamp changes. Returns " +
        "{reloaded, fromStamp, toStamp, targetStamp, waitedMs}. Call it between an extension " +
        "code change and re-running tests so you never benchmark stale code.",
      cap: "dev",
      schema: {
        type: "object",
        properties: {
          timeoutMs: {
            type: "number",
            description: "Max ms to wait for the reloaded extension to reconnect with a new buildStamp (default 15000).",
          },
        },
        required: [],
      },
    },
  ];
}

function eventsTools(): ToolDef[] {
  return [
    {
      name: "vortex_events",
      action: "__mcp_events__",
      description: "Manage event subscriptions. op=subscribe|unsubscribe|drain. Events piggyback on responses.",
      schema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["subscribe", "unsubscribe", "drain"],
          },
          types: {
            type: "array",
            items: { type: "string" },
            description: "Event types. Known: user.switched_tab, dialog.opened, download.completed, console.error, dom.mutated.",
          },
          minLevel: {
            type: "string",
            enum: ["info", "notice", "urgent"],
            default: "urgent",
          },
          tabId: { type: "number" },
          subscriptionId: { type: "string" },
        },
        required: ["op"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Observe（1 个）
// ──────────────────────────────────────────────────────────────────────────────

function observeTools(): ToolDef[] {
  return [
    {
      name: "vortex_observe",
      action: "observe.snapshot",
      description: "Get interactive elements (@<hash>:eN / @<hash>:fNeM refs — 4-hex snapshot hash binds the ref to its originating snapshot; bare @eN / @fNeM still resolve in v0.8.x). If too few results (e.g. iframes or below-fold), try frames='all-same-origin' or viewport='full' before falling back to get_html.",
      schema: {
        type: "object",
        properties: {
          detail: {
            type: "string",
            description: "'compact'=Markdown (token-efficient, default); 'full'=JSON with bbox/attrs (debug).",
            enum: ["compact", "full"],
            default: "compact",
          },
          viewport: {
            type: "string",
            description: "'visible'=in-viewport only (fast); 'full'=whole document (use when content below the fold).",
            enum: ["visible", "full"],
            default: "visible",
          },
          maxElements: { type: "number", default: 80 },
          includeAX: { type: "boolean", default: true },
          includeText: { type: "boolean", default: true },
          frames: {
            description: "Default 'main' skips iframes. Use 'all-same-origin' for SPAs embedding iframes; 'all-permitted' adds cross-origin frames the extension can reach.",
            oneOf: [
              { type: "string", enum: ["main", "all-same-origin", "all-permitted", "all"] },
              { type: "array", items: { type: "number" } },
            ],
            default: "main",
          },
          includeBoxes: {
            type: "boolean",
            description: "Append per-element bbox=[x,y,w,h] (integer px, frame-local viewport coords) to compact output; emits '# frame N offset=[x,y]' meta line for scanned non-main frames. Off-screen / zero-area elements omit the bbox segment. Default false. For visual-grounding callers (hybrid a11y-ref + bbox to a vision model).",
            default: false,
          },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: [],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Tab（3 个）
// ──────────────────────────────────────────────────────────────────────────────

function tabTools(): ToolDef[] {
  return [
    {
      name: "vortex_tab_list",
      action: "tab.list",
      description: "List open tabs with IDs, URLs, titles.",
      schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "vortex_tab_create",
      action: "tab.create",
      description: "Create tab, optionally navigate to URL. Activates by default.",
      schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          active: { type: "boolean", default: true },
        },
        required: [],
      },
    },
    {
      name: "vortex_tab_close",
      action: "tab.close",
      description: "Close tab by ID.",
      schema: {
        type: "object",
        properties: { tabId: { type: "number" } },
        required: ["tabId"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Page（5 个）
// ──────────────────────────────────────────────────────────────────────────────

function pageTools(): ToolDef[] {
  return [
    {
      name: "vortex_navigate",
      action: "page.navigate",
      description: "Navigate to URL, or reload page if reload:true.",
      schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL (omit when reload:true)." },
          reload: { type: "boolean", description: "Reload current page." },
          waitForLoad: { type: "boolean", default: true },
          timeout: { type: "number", default: 30000 },
          ...optionalTabId,
        },
        required: [],
      },
    },
    {
      name: "vortex_page_info",
      action: "page.info",
      description: "Get page URL, title, load status.",
      schema: { type: "object", properties: { ...optionalTabId }, required: [] },
    },
    {
      name: "vortex_history",
      action: "page.back",
      description: "Go back or forward in browser history.",
      schema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["back", "forward"], default: "back" },
          ...optionalTabId,
        },
        required: [],
      },
    },
    {
      name: "vortex_wait",
      action: "page.wait",
      description: "Wait for CSS selector to appear or wait fixed timeout.",
      schema: {
        type: "object",
        properties: {
          target: { type: "string", description: "CSS selector or @<hash>:eN ref (bare @eN accepted in v0.8.x; deprecated in v0.9)." },
          timeout: { type: "number", default: 10000 },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: [],
      },
    },
    {
      name: "vortex_wait_idle",
      action: "page.waitForXhrIdle",
      description: "Wait for network/XHR/DOM idle. kind: 'xhr' (default) | 'network' | 'dom'.",
      schema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["xhr", "network", "dom"],
            default: "xhr",
          },
          idleMs: { type: "number" },
          timeout: { type: "number", default: 10000 },
          target: { type: "string" },
          ...optionalTabId,
        },
        required: [],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// DOM 交互（8 个）
// ──────────────────────────────────────────────────────────────────────────────

function domTools(): ToolDef[] {
  return [
    {
      name: "vortex_click",
      action: "dom.click",
      description: "Click element by @<hash>:eN ref or selector (bare @eN accepted in v0.8.x; deprecated in v0.9). Scrolls into view.",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          useRealMouse: { type: "boolean" },
          // GAP-G(N0062): 效果信号采集，与 public vortex_act options.observeEffect 对齐
          observeEffect: { type: "boolean" },
          windowMs: { type: "number" },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: [],
      },
    },
    {
      name: "vortex_type",
      action: "dom.type",
      description: "Type text char-by-char into element. Use vortex_fill for faster input.",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          text: { type: "string" },
          delay: { type: "number" },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["text"],
      },
    },
    {
      name: "vortex_fill",
      action: "dom.fill",
      description: "Set field value directly. Use widget for framework components. value shape depends on widget: daterange/datetimerange={start,end}; cascader=[level1,level2,...]; select/checkbox-group=string|string[].",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          value: { description: "Plain value for inputs; {start,end} for date ranges; array for cascader/multi-select." },
          widget: {
            type: "string",
            enum: [...COMMIT_KINDS],
            description: "Omit for plain inputs. Targets Element Plus / Ant Design composite widgets.",
          },
          fallbackToNative: { type: "boolean", default: false },
          timeout: { type: "number", default: 8000 },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["value"],
      },
    },
    {
      name: "vortex_select",
      action: "dom.select",
      description: "Select option in <select> dropdown by value.",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          value: { type: "string" },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["value"],
      },
    },
    {
      name: "vortex_hover",
      action: "dom.hover",
      description: "Hover over element to trigger hover effects.",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: [],
      },
    },
    {
      name: "vortex_batch",
      action: "dom.batch",
      description: "Execute multiple DOM ops in sequence. Rolls back on failure.",
      schema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["click", "fill", "type", "select", "scroll", "hover"] },
                target: { type: "string", description: "@<hash>:eN ref or CSS selector (bare @eN accepted in v0.8.x; deprecated in v0.9)." },
                value: { type: "string" },
                delay: { type: "number" },
                position: { type: "string" },
              },
              required: ["op"],
            },
          },
          rollbackOnFailure: { type: "boolean", default: true },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["operations"],
      },
    },
    {
      name: "vortex_press",
      action: "keyboard.press",
      description: "Press key or shortcut (e.g. 'Enter', 'Ctrl+S', 'Tab').",
      schema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key or combo ('Enter', 'Ctrl+A')." },
          ...optionalTabId,
        },
        required: ["key"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Content（2 个）
// ──────────────────────────────────────────────────────────────────────────────

function contentTools(): ToolDef[] {
  return [
    {
      name: "vortex_get_text",
      action: "content.getText",
      description: "Get visible text from page or element.",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          maxBytes: { type: "integer", minimum: 4096, maximum: 5242880, default: 16384 },
          ...optionalTabId,
          ...optionalFrameId,
          ...optionalFrameRef,
        },
        required: [],
      },
    },
    {
      name: "vortex_get_html",
      action: "content.getHTML",
      description: "Get outer HTML from page or element.",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          maxBytes: { type: "integer", minimum: 4096, maximum: 5242880, default: 16384 },
          ...optionalTabId,
          ...optionalFrameId,
          ...optionalFrameRef,
        },
        required: [],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// JS 执行（1 个）
// ──────────────────────────────────────────────────────────────────────────────

function jsTools(): ToolDef[] {
  return [
    {
      name: "vortex_evaluate",
      action: "js.evaluate",
      description: "Execute JavaScript in page context. Set async:true for await support.",
      schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          async: { type: "boolean", description: "Use evaluateAsync.", default: false },
          ...optionalTabId,
          ...optionalFrameId,
          ...optionalFrameRef,
        },
        required: ["code"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// 鼠标（2 个）
// ──────────────────────────────────────────────────────────────────────────────

function mouseTools(): ToolDef[] {
  return [
    {
      name: "vortex_mouse_click",
      action: "mouse.click",
      description: "Click at x,y (CDP real mouse). Use frameId for iframe coords. clickCount=2 for double-click.",
      schema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
          clickCount: { type: "number", default: 1 },
          coordSpace: { type: "string", enum: ["frame", "viewport"] },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["x", "y"],
      },
    },
    {
      name: "vortex_mouse_move",
      action: "mouse.move",
      description: "Move mouse to x,y.",
      schema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          coordSpace: { type: "string", enum: ["frame", "viewport"] },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["x", "y"],
      },
    },
    {
      name: "vortex_mouse_drag",
      action: "mouse.drag",
      description:
        "Drag from (fromX,fromY) to (toX,toY) via CDP real mouse: move → press → N-step moves → release. steps default 10, ~10ms between steps.",
      schema: {
        type: "object",
        properties: {
          fromX: { type: "number" },
          fromY: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
          steps: { type: "number", default: 10, description: "Interpolation steps for smoother drag" },
          coordSpace: { type: "string", enum: ["frame", "viewport"] },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["fromX", "fromY", "toX", "toY"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// 截图（1 个）
// ──────────────────────────────────────────────────────────────────────────────

function captureTools(): ToolDef[] {
  return [
    {
      name: "vortex_screenshot",
      action: "capture.screenshot",
      description: "Screenshot page or element (provide target). returnMode: inline|file.",
      schema: {
        type: "object",
        properties: {
          ...targetRef,
          format: { type: "string", enum: ["png", "jpeg"], default: "png" },
          fullPage: { type: "boolean" },
          clip: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
          returnMode: {
            type: "string",
            enum: ["inline", "file"],
            default: "inline",
          },
          ...optionalTabId,
          ...optionalFrameRef,
        },
        required: [],
      },
      returnsImage: true,
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Console & Network（2 个）
// ──────────────────────────────────────────────────────────────────────────────

function consoleTools(): ToolDef[] {
  return [
    {
      name: "vortex_console",
      action: "console.getLogs",
      description: "Get or clear console logs. op: 'get' (default) | 'clear'. Filter by level.",
      schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["get", "clear"], default: "get" },
          level: { type: "string", enum: ["log", "warn", "error"] },
          ...optionalTabId,
        },
        required: [],
      },
    },
  ];
}

function networkTools(): ToolDef[] {
  return [
    {
      name: "vortex_network",
      action: "network.getLogs",
      description: "Get/filter/clear network logs. op: 'get' | 'filter' | 'clear'.",
      schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["get", "filter", "clear"], default: "get" },
          filter: {
            type: "object",
            properties: {
              url: { type: "string" },
              method: { type: "string" },
              statusMin: { type: "number" },
              statusMax: { type: "number" },
              includeResources: { type: "boolean" },
            },
          },
          includeResources: { type: "boolean" },
          ...optionalTabId,
        },
        required: [],
      },
    },
    {
      name: "vortex_network_response_body",
      action: "network.getResponseBody",
      description: "Get response body of network request by requestId.",
      schema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          ...optionalTabId,
        },
        required: ["requestId"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Storage（3 个）
// ──────────────────────────────────────────────────────────────────────────────

function storageTools(): ToolDef[] {
  return [
    {
      name: "vortex_storage_get",
      action: "storage.getCookies",
      description: "Read cookies/localStorage/sessionStorage. scope: 'cookie' | 'local' | 'session'.",
      schema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["cookie", "local", "session"],
          },
          url: { type: "string" },
          domain: { type: "string" },
          key: { type: "string" },
          ...optionalTabId,
        },
        required: ["scope"],
      },
    },
    {
      name: "vortex_storage_set",
      action: "storage.setCookie",
      description: "Set/delete cookie/localStorage/sessionStorage. scope: 'cookie'|'local'|'session'.",
      schema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["cookie", "local", "session"] },
          op: { type: "string", enum: ["set", "delete"], default: "set" },
          url: { type: "string" },
          name: { type: "string" },
          value: { type: "string" },
          key: { type: "string" },
          domain: { type: "string" },
          path: { type: "string" },
          secure: { type: "boolean" },
          httpOnly: { type: "boolean" },
          expirationDate: { type: "number" },
          sameSite: { type: "string" },
          ...optionalTabId,
        },
        required: ["scope"],
      },
    },
    {
      name: "vortex_storage_session",
      action: "storage.exportSession",
      description: "Export or import full session (cookies + storage). op: 'export' | 'import'.",
      schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["export", "import"] },
          domain: { type: "string" },
          data: { type: "object" },
          ...optionalTabId,
        },
        required: ["op"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// File（3 个）
// ──────────────────────────────────────────────────────────────────────────────

function fileTools(): ToolDef[] {
  return [
    {
      name: "vortex_file_upload",
      action: "file.upload",
      description: "Upload file to input element. fileContent must be base64.",
      schema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          fileName: { type: "string" },
          fileContent: { type: "string" },
          mimeType: { type: "string" },
          ...optionalTabId,
        },
        required: ["selector", "fileName", "fileContent"],
      },
    },
    {
      name: "vortex_file_download",
      action: "file.download",
      description: "Trigger file download by URL.",
      schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          filename: { type: "string" },
        },
        required: ["url"],
      },
    },
    {
      name: "vortex_file_list_downloads",
      action: "file.getDownloads",
      description: "List recent file downloads.",
      schema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 20 },
        },
        required: [],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Frames（1 个）
// ──────────────────────────────────────────────────────────────────────────────

function framesTools(): ToolDef[] {
  return [
    {
      name: "vortex_frames_list",
      action: "frames.list",
      description: "List frames in tab. Returns { frameId, url, parentFrameId }.",
      schema: { type: "object", properties: { ...optionalTabId }, required: [] },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Verify（1 个，cap:"testing" opt-in）
// ──────────────────────────────────────────────────────────────────────────────

function verifyTools(): ToolDef[] {
  return [
    {
      name: "vortex_verify",
      action: "verify.assert",
      // testing cap 工具：经 --caps=testing 提升进 public。断言走 observe AX 树
      // 比对，绝不旁路 evaluate 做 DOM 查询。失败返回 {ok:false,expected,actual}。
      description:
        "Assert page state via the observe a11y tree (testing cap). " +
        "mode=visible(role+name exists & visible) / value(element value equals expected) / " +
        "text(element name contains substring) / list(all items present). " +
        "Pass target=@ref to scope value/text assertions to a specific element. " +
        "Returns {ok:true} or {ok:false,expected,actual}.",
      cap: "testing",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["visible", "value", "text", "list"],
            description: "Assertion mode.",
          },
          role: { type: "string", description: "ARIA role to match (visible/value mode)." },
          name: { type: "string", description: "Accessible name to match (visible/value mode)." },
          target: { type: "string", description: "@<hash>:eN ref to scope value/text assertions to the specific element identified by the ref." },
          value: { description: "Expected value (value mode). For text inputs reflects the current IDL value after fill." },
          text: { type: "string", description: "Expected substring to find in element name(s) (text mode). Pass target to restrict search to a specific element." },
          items: {
            type: "array",
            items: { type: "object", properties: { role: { type: "string" }, name: { type: "string" } }, required: ["name"] },
            description: "List of {role?,name} to all assert present (list mode).",
          },
          ...optionalTabId,
          ...optionalFrameId,
        },
        required: ["mode"],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// 导出
// ──────────────────────────────────────────────────────────────────────────────

export function getAllToolDefs(): ToolDef[] {
  return [
    ...diagnosticsTools(),
    ...devTools(),
    ...eventsTools(),
    ...observeTools(),
    ...tabTools(),
    ...pageTools(),
    ...domTools(),
    ...contentTools(),
    ...jsTools(),
    ...mouseTools(),
    ...captureTools(),
    ...consoleTools(),
    ...networkTools(),
    ...storageTools(),
    ...fileTools(),
    ...framesTools(),
    ...verifyTools(),
  ];
}
