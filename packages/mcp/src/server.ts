#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { watch } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { sendRequest } from "./client.js";
import { getToolDefs, getToolDef } from "./tools/registry.js";
import { dispatchNewTool } from "./tools/dispatch.js";
import { computeTransportTimeout } from "./lib/timeout.js";
export { dispatchNewTool };

// Read package.json via createRequire so the bundle works under both ts-node
// and the compiled dist layout. The relative path is resolved against this
// file's URL; vitest occasionally re-roots that URL, so swallow resolution
// errors and fall back to a sentinel rather than refusing to load the
// module (handleCallTool is unit-tested through this path).
const require_ = createRequire(import.meta.url);
let MCP_VERSION = "0.0.0-test";
try {
  MCP_VERSION = (require_("../../package.json") as { version: string }).version;
} catch {
  // package.json not resolvable (test sandbox); MCP_VERSION stays at the
  // sentinel — production paths always succeed because dist/ ships next to
  // package.json.
}

/**
 * 计算当前 MCP 注册的所有工具指纹。
 * 变更任一工具 name / action / description 都会影响 hash。
 * 代理拿到 ping 响应里的 schemaHash 可对比自己缓存的版本，
 * 判断 MCP server 是否被重启过（典型场景：merge 了新 PR 但 Claude Code 还没重启）。
 */
function computeSchemaHash(): string {
  const defs = getToolDefs();
  const payload = defs.map((d) => `${d.name}:${d.action}:${d.description.length}`).sort().join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
import {
  saveBase64Image,
  getImageSize,
  estimateImageBytes,
  fullPageTruncationWarning,
} from "./lib/image-utils.js";
import { eventStore } from "./lib/event-store.js";
import { VtxError, DEFAULT_ERROR_META, type VtxEventLevel, type VtxErrorCode } from "@vortex-browser/shared";

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** 普通 tool response 附加 piggyback 事件 */
function formatError(err: unknown): string {
  if (err instanceof VtxError) {
    const hint = err.extra?.hint ? `\nHint: ${err.extra.hint}` : "";
    return `Error [${err.code}]: ${err.message}${hint}`;
  }
  return (err as Error)?.message ?? String(err);
}

function withEvents(content: ContentItem[]): { content: ContentItem[] } {
  const events = eventStore.drain();
  if (events.length > 0) {
    content.push({
      type: "text",
      text: `[vortex-events] ${events.length} event(s) delivered:\n${JSON.stringify(events, null, 2)}`,
    });
  }
  return { content };
}

export function computeSnapshotHash(id: string | null): string | null {
  if (!id) return null;
  return createHash("sha256").update(id).digest("hex").slice(0, 4);
}

let activeSnapshotId: string | null = null;
let activeSnapshotHash: string | null = null;
// 缺陷⑤ (2026-06-07 v4 淘宝评测): 同时记 active snapshot 的 tabId,
// 在 resolveTargetParam 入口与本次调用 args.tabId 比对, 防止 bare ref
// 跨导航/跨 tab 绕过 v0.8 hash 严判。null = 尚未 observe 过 (等同无 snapshot)。
let activeSnapshotTabId: number | null = null;

const PORT = parseInt(process.env.VORTEX_PORT ?? "6800");
const DEFAULT_TIMEOUT = parseInt(process.env.VORTEX_TIMEOUT_MS ?? "30000");
const LARGE_IMAGE_BYTES = 500_000;   // 超过 500KB 的图片默认切 file 模式
// 非图片响应默认 100KB 截断,保护真 agent 上下文不被刷爆。可经 env 覆盖:
// 程序化客户端(如 vortex-bench 的 snapshot 序列化,结果 client→server→client 不进
// agent 上下文)需要完整大响应,设高 VORTEX_RESPONSE_SIZE_LIMIT 即可。非法值回落默认。
const RESPONSE_SIZE_LIMIT = (() => {
  const raw = process.env.VORTEX_RESPONSE_SIZE_LIMIT;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100_000;
})();

/**
 * 自重启机制（@since 0.4.0）：
 *
 * MCP server 作为 Claude Code 的 stdio 子进程长驻，每次 `pnpm -r build` 刷新 dist
 * 后，若 server 不重启，Claude 就永远看不到新工具 schema（典型踩坑）。
 *
 * 方案：watch 自身所在 dist 目录，`.js` 变更即标记 pendingRestart，等 inflight
 * 请求归零后 `process.exit(0)`。Claude Code 的 MCP stdio client 在子进程退出后
 * 下次 tool_call 触发自动 respawn，读到最新 schema。
 *
 * 关键安全点：
 *  - 必须等 inflight=0 才 exit，否则正在处理的请求会丢响应。
 *  - 不 watch src/（只 watch dist/），避免 dev 模式频繁误触发。
 *  - VORTEX_MCP_NO_AUTO_RESTART=1 提供 opt-out（CI 环境可关闭）。
 */
let inflight = 0;
let pendingRestart = false;
const AUTO_RESTART = process.env.VORTEX_MCP_NO_AUTO_RESTART !== "1";

function maybeExitAfterDrain(): void {
  if (pendingRestart && inflight === 0) {
    process.stderr.write(
      "[vortex-mcp] dist changed and inflight drained; exiting for Claude Code to respawn with fresh schema.\n",
    );
    // setImmediate 给 stderr 一次 flush 机会
    setImmediate(() => process.exit(0));
  }
}

function installAutoRestart(): void {
  if (!AUTO_RESTART) return;
  // __dirname 等价：本文件所在目录（dist/src/ 在运行期，src/ 在测试期——后者 fs.watch 也能跑）
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const watcher = watch(here, { recursive: true }, (eventType, filename) => {
      if (eventType !== "change" && eventType !== "rename") return;
      if (!filename || !filename.endsWith(".js")) return;
      if (pendingRestart) return; // already armed
      pendingRestart = true;
      process.stderr.write(
        `[vortex-mcp] dist file changed (${filename}); will exit after current requests drain.\n`,
      );
      maybeExitAfterDrain();
    });
    watcher.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[vortex-mcp] fs.watch failed: ${msg}; auto-restart disabled.\n`);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[vortex-mcp] fs.watch init failed: ${msg}; auto-restart disabled.\n`);
  }
}

const server = new Server(
  { name: "vortex", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const defs = getToolDefs();
  return {
    tools: defs.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.schema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  inflight++;
  try {
    return await handleCallTool(request);
  } finally {
    inflight--;
    maybeExitAfterDrain();
  }
});

// Exported for unit tests so the vortex_observe special path (and the
// activeSnapshotId follow-on) can be exercised without standing up the MCP
// transport. Production callers still go through the SDK request handler
// registered above.
export async function handleCallTool(
  request: { params: { name: string; arguments?: unknown } },
): Promise<{ content: ContentItem[]; isError?: boolean }> {
  const { name, arguments: args } = request.params;
  const toolDef = getToolDef(name);

  if (!toolDef) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    };
  }

  const params = (args ?? {}) as Record<string, unknown>;

  // 特殊 tool: vortex_events（合并原三个 __mcp_events_*__ 分支）
  if (toolDef.name === "vortex_events") {
    const op = params.op as string;
    if (op === "subscribe") {
      const subId = eventStore.subscribe({
        types: params.types as string[] | undefined,
        minLevel: params.minLevel as VtxEventLevel | undefined,
        tabId: params.tabId as number | undefined,
      });
      return withEvents([{
        type: "text" as const,
        text: JSON.stringify({
          subscriptionId: subId,
          note: "Events will be piggybacked to subsequent tool responses in a `[vortex-events]` text item.",
        }, null, 2),
      }]);
    }
    if (op === "unsubscribe") {
      const ok = eventStore.unsubscribe(params.subscriptionId as string);
      return withEvents([{
        type: "text" as const,
        text: JSON.stringify({ unsubscribed: ok }, null, 2),
      }]);
    }
    if (op === "drain") {
      let flushed: { notice: number; info: number } = { notice: 0, info: 0 };
      try {
        const resp = await sendRequest("events.drain", {}, PORT, undefined, 5000);
        const result = (resp.result ?? {}) as { flushed?: { notice: number; info: number } };
        if (result.flushed) flushed = result.flushed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const events = eventStore.drain();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ events, flushed, note: `flush failed: ${msg}` }, null, 2),
          }],
        };
      }
      const events = eventStore.drain();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ events, flushed }, null, 2),
        }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Unknown events op: ${op}` }],
    };
  }

  // 特殊 tool: vortex_ping（MCP 自身诊断 + 版本指纹，@since 0.4.0）
  if (toolDef.action === "__mcp_ping__") {
    try {
      const { getBareRefStats } = await import("./lib/ref-parser.js");
      const [tabsResp, versionResp] = await Promise.allSettled([
        sendRequest("tab.list", {}, PORT, undefined, 5000),
        sendRequest("diagnostics.version", {}, PORT, undefined, 5000),
      ]);
      const tabs =
        tabsResp.status === "fulfilled" && Array.isArray(tabsResp.value.result)
          ? tabsResp.value.result
          : [];
      const versionInfo =
        versionResp.status === "fulfilled"
          ? (versionResp.value.result as {
              extensionVersion?: string;
              actionCount?: number;
              actions?: string[];
            } | undefined) ?? {}
          : {};
      const toolCount = getToolDefs().length;
      const schemaHash = computeSchemaHash();

      // 版本漂移检测：MCP 与扩展的语义主版本不一致时给出明显提示。
      const extVersion = versionInfo.extensionVersion;
      const versionDrift =
        extVersion && extVersion !== "unknown" && extVersion !== MCP_VERSION
          ? `MCP (${MCP_VERSION}) ≠ extension (${extVersion}). Rebuild + reload may be needed.`
          : undefined;
      // 扩展太旧时，它汇报的 actions 不会包含 diagnostics.version，此时 versionInfo 为空。
      const diagnosticsSupported = typeof extVersion === "string";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "ok",
            vortexServer: `localhost:${PORT}`,
            tabCount: tabs.length,
            timeoutMs: DEFAULT_TIMEOUT,
            mcpVersion: MCP_VERSION,
            extensionVersion: extVersion ?? "unknown",
            schemaHash,
            toolCount,
            extensionActionCount: versionInfo.actionCount ?? null,
            diagnosticsSupported,
            bareRefUsage: getBareRefStats(),
            ...(versionDrift ? { warning: versionDrift } : {}),
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `vortex-server unreachable at localhost:${PORT}.\n${err.message}\n\nTo start: cd /path/to/vortex && pnpm --filter @vortex-browser/server start`,
        }],
      };
    }
  }

  // observe.snapshot 专用分发：compact → 紧凑文本，full → 原 JSON pretty
  // PR #4 把 vortex_observe 的 toolDef.action 从 "observe.snapshot" 改成 "L4.observe"，
  // 这条 condition 必须同时识别两者，否则 v0.6 vortex_observe 会绕开整个 special
  // path（含 activeSnapshotId tracking + compact rendering），导致后续 @eN ref 全部
  // STALE_SNAPSHOT，且 observe 输出退化为 60KB raw JSON。
  const isObserveTool =
    toolDef.name === "vortex_observe" || toolDef.action === "observe.snapshot";
  if (isObserveTool) {
    const detail = (params.detail as "compact" | "full") ?? "compact";
    const { scope, filter, tabId, timeout, ...rest } = params;
    const effectiveTimeout = (timeout as number) ?? DEFAULT_TIMEOUT;
    // v0.6 schema 暴露 scope/filter 而非 v0.5 的 viewport/filter；在此 reshape，
    // 与 dispatch.ts case "vortex_observe" 保持等价（special path 会先 return，
    // 不会再落到 dispatchNewTool）。
    const next: Record<string, unknown> = { ...rest, format: detail };
    if (scope === "full") next.viewport = "full";
    else if (scope === "viewport") next.viewport = "visible";
    if (filter !== undefined) next.filter = filter;
    // 始终用显式 "observe.snapshot" 作为发到 extension 的 action（toolDef.action
    // 在 v0.6 是 "L4.observe"，extension 端无对应 handler）。
    const resp = await sendRequest(
      "observe.snapshot",
      next,
      PORT,
      tabId as number | undefined,
      effectiveTimeout,
    );
    if (resp.error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error [${resp.error.code}]: ${resp.error.message}` }],
      };
    }
    // 追踪活跃 snapshotId，供后续动作工具 target 翻译使用
    const snapshotResult = resp.result as { snapshotId?: string };
    if (snapshotResult?.snapshotId) {
      activeSnapshotId = snapshotResult.snapshotId;
      activeSnapshotHash = computeSnapshotHash(snapshotResult.snapshotId);
      // 缺陷⑤ (2026-06-07 v4 淘宝评测): 同步记 activeSnapshotTabId 用于
      // tab 维度校验, 防止 bare ref 跨导航绕过 v0.8 hash 严判。tabId 在
      // observe 调用 args 中, 上方 const { scope, filter, tabId, timeout, ...rest }
      // 已解构。若未传 tabId, 保持 null, resolveTargetParam 不强制校验。
      activeSnapshotTabId =
        typeof tabId === "number" ? tabId : null;
    }
    if (detail === "compact") {
      const { renderObserveCompact } = await import("./lib/observe-render.js");
      // Issue #21 — thread caller's includeBoxes through to the renderer.
      // The flag is also already inside `next` (spread `...rest`) so the
      // extension handler sees it on its own; render needs the bool too
      // to decide whether to emit `bbox=` segments and frame offset lines.
      const includeBoxes = params.includeBoxes === true;
      const text = renderObserveCompact(resp.result as any, activeSnapshotHash, includeBoxes);
      return withEvents([{ type: "text" as const, text }]);
    }
    // detail=full：原 JSON pretty（与 v0.4 行为一致）
    // result 为 undefined(副作用型 eval:scrollTo/click/forEach/setItem… 极常见,
    // 或 async eval 漏写 return)时,旧 `resp.result ?? resp` 会回退成整个 VtxResponse,
    // JSON 丢掉 undefined 字段 → 吐出晦涩的 `{action,id}`(像空响应/错误,泄漏内部协议
    // 字段)。改用 `JSON.stringify(resp.result, null, 2) ?? "undefined"`:利用
    // JSON.stringify(undefined) 返回 JS undefined(非字符串)的特性,精确把 undefined
    // 渲染成 "undefined"、null 渲染成 "null";falsy 值(0/false/"")不受影响。见已关闭 #35。
    const resultText = JSON.stringify(resp.result, null, 2) ?? "undefined";
    return withEvents([{ type: "text" as const, text: resultText }]);
  }

  // target 翻译：@eN / @fNeM → { index, snapshotId, frameId }
  const target = params.target as string | undefined;
  if (target) {
    try {
      const { resolveTargetParam } = await import("./lib/ref-parser.js");
      // 缺陷⑤ (2026-06-07 v4 淘宝评测): 传 activeTabId + currentTabId
      // 给 resolveTargetParam, 跨 tab/导航 throw STALE_SNAPSHOT。
      const currentTabId =
        typeof params.tabId === "number" ? params.tabId : null;
      const resolved = resolveTargetParam(
        target,
        activeSnapshotId,
        activeSnapshotHash,
        activeSnapshotTabId,
        currentTabId,
      );
      delete params.target;
      if (resolved.selector) params.selector = resolved.selector;
      if (resolved.index != null) {
        params.index = resolved.index;
        params.snapshotId = resolved.snapshotId;
        // 跨 frame 时透传 frameId（frameId === 0 表示主 frame，不设即可）
        if (resolved.frameId && resolved.frameId !== 0) params.frameId = resolved.frameId;
      }
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: formatError(err) }],
      };
    }
  }

  // frameRef 翻译：@fN → frameId
  const frameRef = params.frameRef as string | undefined;
  if (frameRef) {
    const m = frameRef.match(/^@f(\d+)$/);
    if (!m) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Invalid frameRef: ${frameRef} (expected @fN)` }],
      };
    }
    delete params.frameRef;
    params.frameId = parseInt(m[1], 10);
  }

  try {
    const { tabId, returnMode, timeout, ...rest } = params;
    // WAIT-TIMEOUT-MARGIN(族 O):调用方 timeout 既要作 handler 内层 poll 预算,又决定
    // 外层传输超时。原先只设传输(= caller),内层被 destructure 摘走拿不到 → handler 用
    // 自身 default,且传输与内层同 deadline 竞race。修复:(1) 把 timeout 塞回 rest 让
    // dispatchNewTool 透传给 handler 作内层预算;(2) 传输 = 内层 + buffer 留 margin,
    // 确保 handler 干净结果(condition-not-met)先于传输 "no response" 到达调用方。
    if (timeout !== undefined) rest.timeout = timeout;
    const effectiveTimeout = computeTransportTimeout(timeout as number | undefined, DEFAULT_TIMEOUT);

    // dispatch 映射：新工具名 → 正确 action + 参数 reshape
    const mapped = dispatchNewTool(toolDef.name, rest);
    const action = mapped ? mapped.action : toolDef.action;
    const mappedParams = mapped ? mapped.params : rest;

    const resp = await sendRequest(
      action,
      mappedParams,
      PORT,
      tabId as number | undefined,
      effectiveTimeout,
    );

    // Action 执行错误
    if (resp.error) {
      const code = resp.error.code;
      // 远端 RPC error 经 toJSON 已带 hint（remote vtxError 自动注入），但
      // 早期 handler / page-side throw 的 sentinel 字符串没有 hint。这里
      // 三层兜底：remote hint > DEFAULT_ERROR_META > STALE_SNAPSHOT 中文兜底。
      // 同时对 Actionability TIMEOUT 携带 lastReason=NOT_ATTACHED 的场景额外
      // 拼接 NOT_ATTACHED hint —— surface code 是 TIMEOUT 但根因是 ref detach
      // （P0-3, 2026-05-21 用户报告）。
      let hintText = "";
      if (resp.error.hint) {
        hintText = `\nHint: ${resp.error.hint}`;
      } else if (code === "STALE_SNAPSHOT") {
        hintText = "\nHint: DOM 已变更，ref 失效。请重新调用 vortex_observe 获取新 snapshot。";
      } else {
        const meta = DEFAULT_ERROR_META[code as VtxErrorCode];
        if (meta?.hint) hintText = `\nHint: ${meta.hint}`;
      }
      const lastReason = (resp.error.context?.extras as { lastReason?: string } | undefined)?.lastReason;
      if (code === "TIMEOUT" && lastReason === "NOT_ATTACHED") {
        const notAttachedHint = DEFAULT_ERROR_META["NOT_ATTACHED" as VtxErrorCode]?.hint;
        if (notAttachedHint) hintText += `\nHint (lastReason=NOT_ATTACHED): ${notAttachedHint}`;
      }
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Error [${code}]: ${resp.error.message}${hintText}`,
        }],
      };
    }

    // 图片返回（screenshot / element）
    if (toolDef.returnsImage && resp.result) {
      const result = resp.result as { dataUrl?: string; [k: string]: unknown };
      if (result.dataUrl) {
        const { width, height } = getImageSize(result.dataUrl);
        const bytes = estimateImageBytes(result.dataUrl);

        // 超大图自动切到 file 模式
        const mode =
          returnMode === "file" ||
          (returnMode !== "inline" && bytes > LARGE_IMAGE_BYTES)
            ? "file"
            : "inline";

        // CAP-1: fullPage 被裁断时,截断信息须显式 surface(图片块本身不带元数据)
        const truncWarning = fullPageTruncationWarning(result as {
          truncated?: boolean; contentHeight?: number; capturedHeight?: number;
        });

        if (mode === "file") {
          const prefix = action.replace(/\./g, "-");
          const { path, bytes: savedBytes } = saveBase64Image(result.dataUrl, prefix);
          return withEvents([{
            type: "text" as const,
            text: JSON.stringify({
              savedTo: path,
              width,
              height,
              bytes: savedBytes,
              ...(result.truncated
                ? { truncated: true, contentHeight: result.contentHeight, capturedHeight: result.capturedHeight }
                : {}),
              note: "Image saved to file to conserve tokens. Use the Read tool with the savedTo path to view it.",
            }, null, 2),
          }]);
        }

        // inline 模式
        const m = result.dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (m) {
          const items: ContentItem[] = [];
          if (truncWarning) items.push({ type: "text" as const, text: truncWarning });
          items.push({ type: "image" as const, data: m[2], mimeType: `image/${m[1]}` });
          return withEvents(items);
        }
      }
    }

    // 普通响应 + 超大截断
    // result 为 undefined(副作用型 eval:scrollTo/click/forEach/setItem… 极常见,
    // 或 async eval 漏写 return)时,旧 `resp.result ?? resp` 会回退成整个 VtxResponse,
    // JSON 丢掉 undefined 字段 → 吐出晦涩的 `{action,id}`(像空响应/错误,泄漏内部协议
    // 字段)。改用 `JSON.stringify(resp.result, null, 2) ?? "undefined"`:利用
    // JSON.stringify(undefined) 返回 JS undefined(非字符串)的特性,精确把 undefined
    // 渲染成 "undefined"、null 渲染成 "null";falsy 值(0/false/"")不受影响。见已关闭 #35。
    const resultText = JSON.stringify(resp.result, null, 2) ?? "undefined";
    if (resultText.length > RESPONSE_SIZE_LIMIT) {
      const truncated = resultText.slice(0, RESPONSE_SIZE_LIMIT);
      return withEvents([{
        type: "text" as const,
        text: truncated + `\n\n[TRUNCATED: response was ${resultText.length} bytes, showing first ${RESPONSE_SIZE_LIMIT}. Use filter/pagination parameters for smaller responses.]`,
      }]);
    }

    return withEvents([{ type: "text" as const, text: resultText }]);
  } catch (err: any) {
    if (err instanceof VtxError) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: formatError(err) }],
      };
    }
    const msg = err?.message ?? String(err);
    let friendly = msg;
    if (msg.includes("ECONNREFUSED") || msg.includes("Failed to connect")) {
      friendly =
        `vortex-server is not running at localhost:${PORT}.\n` +
        `To start: cd /path/to/vortex && pnpm --filter @vortex-browser/server start\n\n` +
        `Once it's running, retry your last tool call.\n\n` +
        `Original error: ${msg}`;
    } else if (msg.includes("Timeout")) {
      friendly =
        `${msg}\n\n` +
        `Possible causes:\n` +
        `- Tab is still loading (wait and retry, or use vortex_page_wait_for_network_idle)\n` +
        `- Extension not loaded/reloaded (check chrome://extensions)\n` +
        `- Native messaging disconnected (check vortex-server logs)\n` +
        `Set VORTEX_TIMEOUT_MS env var to override the ${DEFAULT_TIMEOUT}ms default.`;
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: friendly }],
    };
  }
}

async function main(): Promise<void> {
  installAutoRestart();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// CLI-entry guard：仅在直接作为 `node server.js` 启动时执行 main()。被 vitest
// import 时 process.argv[1] 指向 vitest runner，main() 不再触发，避免每个
// worker 都跑 fs.watch + stdio.connect 造成 EMFILE 与 5s 以上的导入毛刺。
// 比较走 realpathSync 以兼容 pnpm/npm 的 .bin/ 符号链接。
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error("Failed to start vortex MCP server:", err);
    process.exit(1);
  });
}
