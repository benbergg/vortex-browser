// packages/extension/src/handlers/network.ts

import { NetworkActions, VtxErrorCode, vtxError, VtxEventType } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import type { NativeMessagingClient } from "../lib/native-messaging.js";
import type { EventDispatcher } from "../events/dispatcher.js";

interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  type?: string; // "Document", "XHR", "Fetch", "Script", "Stylesheet", ...
  mimeType?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
}

const API_TYPES = new Set(["XHR", "Fetch"]);
const apiLogs = new Map<number, NetworkEntry[]>();
const resourceLogs = new Map<number, NetworkEntry[]>();
const MAX_API_LOGS = 5000;
const MAX_RESOURCE_LOGS = 500;

interface SubscribeConfig {
  urlPattern?: string;
  types?: Set<string>;
  maxApiLogs?: number;
  maxResourceLogs?: number;
}
const tabConfigs = new Map<number, SubscribeConfig>();

// 请求进行中的临时存储（等待 response）
const pendingRequests = new Map<string, NetworkEntry>();
const subscribedTabs = new Set<number>();
const MAX_RESPONSE_BODIES = 100;
const responseBodies = new Map<string, { tabId: number; body: string; encoding: string }>();

async function getActiveTabId(tabId?: number): Promise<number> {
  if (tabId) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw vtxError(VtxErrorCode.TAB_NOT_FOUND, "No active tab found");
  return tab.id;
}

/**
 * 自动订阅：首次调用 get_logs / get_errors / filter / get_response_body 时
 * 若 tab 尚未订阅，则启用 CDP Network 域并开始收集日志（API 请求，不含静态资源）。
 *
 * 设计：
 * - 不覆盖已有 tabConfigs（若用户显式 SUBSCRIBE 过，保留其 urlPattern/types 等）
 * - 默认不收集 resource 类型日志（静态资源噪声大，需要时仍可手动 SUBSCRIBE 并传配置）
 * - @since 0.4.0
 */
async function ensureSubscribed(
  debuggerMgr: DebuggerManager,
  tabId: number,
): Promise<void> {
  if (subscribedTabs.has(tabId)) return;
  if (!tabConfigs.has(tabId)) tabConfigs.set(tabId, {});
  await debuggerMgr.enableDomain(tabId, "Network");
  subscribedTabs.add(tabId);
}

function addLog(tabId: number, entry: NetworkEntry): void {
  const isApi = API_TYPES.has(entry.type ?? "");
  const store = isApi ? apiLogs : resourceLogs;
  const config = tabConfigs.get(tabId);
  const max = isApi
    ? (config?.maxApiLogs ?? MAX_API_LOGS)
    : (config?.maxResourceLogs ?? MAX_RESOURCE_LOGS);

  if (!store.has(tabId)) store.set(tabId, []);
  const logs = store.get(tabId)!;
  logs.push(entry);
  if (logs.length > max) {
    logs.shift();
  }
}

function mapInitiatorType(it: string): string {
  if (it === "xmlhttprequest") return "XHR";
  if (it === "fetch") return "Fetch";
  return it ? it.charAt(0).toUpperCase() + it.slice(1) : "Other";
}

/**
 * BUG-003 (N0063): 读 page-side Resource Timing 历史。CDP Network 只捕获 enable 之后的请求,
 * 首次 debug_read 之前已发生的全丢(实测 bytenew CDP 0 vs Resource Timing 250)。
 * performance.getEntriesByType('resource') 总能拿到已完成请求的 url/initiator/duration
 * (无 method/status/headers,这是 Resource Timing 的固有限制)。startTime 用 timeOrigin
 * 对齐成 epoch ms,与 CDP 条目(Date.now())可同轴排序。缺 chrome.scripting / performance
 * 时优雅降级返回 []。
 */
async function readResourceTimingEntries(tabId: number): Promise<NetworkEntry[]> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          if (
            typeof performance === "undefined" ||
            typeof performance.getEntriesByType !== "function"
          ) {
            return [];
          }
          const origin = typeof performance.timeOrigin === "number" ? performance.timeOrigin : 0;
          return (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map(
            (e) => ({
              url: e.name,
              initiatorType: e.initiatorType,
              startTime: Math.round(origin + e.startTime),
              duration: Math.round(e.duration),
            }),
          );
        } catch {
          return [];
        }
      },
    });
    const raw = (results[0]?.result ?? []) as Array<{
      url: string;
      initiatorType: string;
      startTime: number;
      duration: number;
    }>;
    return raw.map((r) => ({
      requestId: `rt:${r.url}:${r.startTime}`,
      url: r.url,
      method: "",
      type: mapInitiatorType(r.initiatorType),
      startTime: r.startTime,
      duration: r.duration,
    }));
  } catch (err) {
    // 不静默吞:executeScript 真失败(frame detached / chrome:// 受限页 / CSP / 导航中)
    // 会让历史回填退回空,与"确无历史"无法区分。至少 warn 出信号,便于诊断(review N0063)。
    console.warn(
      "[vortex] Resource Timing 历史回填失败,network 历史可能不完整:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

export function registerNetworkHandlers(
  router: ActionRouter,
  debuggerMgr: DebuggerManager,
  nm: NativeMessagingClient,
  dispatcher: EventDispatcher,
): void {
  debuggerMgr.onEvent((tabId, method, params: any) => {
    if (!subscribedTabs.has(tabId)) return;

    if (method === "Network.requestWillBeSent") {
      const config = tabConfigs.get(tabId);
      // URL 过滤
      if (config?.urlPattern && !params.request.url.includes(config.urlPattern)) return;

      const entry: NetworkEntry = {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        type: params.type ?? null,
        startTime: Date.now(),
        requestHeaders: params.request.headers,
      };
      entry.requestBody = params.request?.postData;

      // type 过滤
      if (config?.types && !config.types.has(entry.type ?? "")) return;

      // 暂存，等待 response
      pendingRequests.set(params.requestId, entry);

      nm.send({
        type: "event",
        event: "network.requestStart",
        data: {
          requestId: entry.requestId,
          url: entry.url,
          method: entry.method,
          type: entry.type ?? null,
        },
        tabId,
      });
    }

    if (method === "Network.responseReceived") {
      const pending = pendingRequests.get(params.requestId);
      if (pending) {
        pending.status = params.response.status;
        pending.statusText = params.response.statusText;
        pending.mimeType = params.response.mimeType;
        pending.responseHeaders = params.response.headers;
        pending.endTime = Date.now();
        pending.duration = pending.endTime - pending.startTime;

        addLog(tabId, pending);
        pendingRequests.delete(params.requestId);

        nm.send({
          type: "event",
          event: "network.responseReceived",
          data: {
            requestId: pending.requestId,
            url: pending.url,
            method: pending.method,
            status: pending.status,
            statusText: pending.statusText ?? null,
            mimeType: pending.mimeType ?? null,
            duration: pending.duration,
          },
          tabId,
        });

        // 4xx/5xx 作为 NETWORK_ERROR_DETECTED 上报（notice 级）
        if (pending.status && pending.status >= 400) {
          dispatcher.emit(
            VtxEventType.NETWORK_ERROR_DETECTED,
            {
              requestId: pending.requestId,
              url: pending.url,
              method: pending.method,
              status: pending.status,
              statusText: pending.statusText,
              duration: pending.duration,
            },
            { tabId },
          );
        }
      }
    }

    if (method === "Network.loadingFinished") {
      const reqId = params.requestId as string;
      debuggerMgr.sendCommand(tabId, "Network.getResponseBody", { requestId: reqId })
        .then((result: any) => {
          responseBodies.set(reqId, {
            tabId,
            body: result.body,
            encoding: result.base64Encoded ? "base64" : "text",
          });
          // FIFO 淘汰
          while (responseBodies.size > MAX_RESPONSE_BODIES) {
            const firstKey = responseBodies.keys().next().value;
            responseBodies.delete(firstKey!);
          }
        })
        .catch(() => {
          // 部分请求（204、重定向等）可能无 body，忽略
        });
    }

    if (method === "Network.loadingFailed") {
      const pending = pendingRequests.get(params.requestId);
      if (pending) {
        pending.error = params.errorText ?? "Loading failed";
        pending.endTime = Date.now();
        pending.duration = pending.endTime - pending.startTime;

        addLog(tabId, pending);
        pendingRequests.delete(params.requestId);

        nm.send({
          type: "event",
          event: "network.requestFailed",
          data: {
            requestId: pending.requestId,
            url: pending.url,
            method: pending.method,
            error: pending.error,
            duration: pending.duration,
          },
          tabId,
        });

        // 加载失败（DNS / connection / abort 等）亦作为 NETWORK_ERROR_DETECTED
        dispatcher.emit(
          VtxEventType.NETWORK_ERROR_DETECTED,
          {
            requestId: pending.requestId,
            url: pending.url,
            method: pending.method,
            error: pending.error,
            duration: pending.duration,
          },
          { tabId },
        );
      }
    }
  });

  // tab 关闭时清理
  chrome.tabs.onRemoved.addListener((tabId) => {
    apiLogs.delete(tabId);
    resourceLogs.delete(tabId);
    subscribedTabs.delete(tabId);
    tabConfigs.delete(tabId);
    // 清理该 tab 的 responseBodies
    for (const [reqId, entry] of responseBodies) {
      if (entry.tabId === tabId) responseBodies.delete(reqId);
    }
  });

  router.registerAll({
    [NetworkActions.SUBSCRIBE]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      const urlPattern = args.urlPattern as string | undefined;
      const types = args.types as string[] | undefined;
      const maxApiLogs = args.maxApiLogs as number | undefined;
      const maxResourceLogs = args.maxResourceLogs as number | undefined;

      tabConfigs.set(tid, {
        urlPattern,
        types: types ? new Set(types) : undefined,
        maxApiLogs,
        maxResourceLogs,
      });

      await debuggerMgr.enableDomain(tid, "Network");
      subscribedTabs.add(tid);
      return {
        subscribed: true,
        tabId: tid,
        config: { urlPattern, types, maxApiLogs, maxResourceLogs },
      };
    },

    [NetworkActions.GET_LOGS]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      await ensureSubscribed(debuggerMgr, tid);
      const includeResources = args.includeResources as boolean | undefined;
      const pattern = (args.pattern ?? args.url) as string | undefined;
      const apis = apiLogs.get(tid) ?? [];
      const cdpResources = includeResources ? (resourceLogs.get(tid) ?? []) : [];
      // BUG-003 (N0063): 回填 Resource Timing 历史 —— CDP 漏 enable 前的请求(首次 debug_read
      // 之前的全丢)。dedup by URL 对 apis + cdpResources 都做,CDP 条目(有 method/status/
      // headers)优先于 RT 摘要,避免 includeResources 时静态资源 CDP+RT 双现(review N0063)。
      const rt = await readResourceTimingEntries(tid);
      const seenUrls = new Set([...apis, ...cdpResources].map((a) => a.url));
      const rtFresh = rt.filter((e) => !seenUrls.has(e.url));
      let merged: NetworkEntry[] = [...apis, ...cdpResources, ...rtFresh];
      // 默认只留 API 类(XHR/Fetch),滤掉静态资源噪声;includeResources 时全保留。
      if (!includeResources) merged = merged.filter((e) => API_TYPES.has(e.type ?? ""));
      // pattern 过滤(debug_read 必带 pattern;缺省则不滤)。
      if (pattern) merged = merged.filter((e) => e.url.includes(pattern));
      return merged.sort((a, b) => a.startTime - b.startTime);
    },

    [NetworkActions.GET_ERRORS]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      await ensureSubscribed(debuggerMgr, tid);
      const includeResources = args.includeResources as boolean | undefined;
      const apis = apiLogs.get(tid) ?? [];
      const source = includeResources
        ? [...apis, ...(resourceLogs.get(tid) ?? [])].sort((a, b) => a.startTime - b.startTime)
        : apis;
      return source.filter((l) => l.error || (l.status && l.status >= 400));
    },

    [NetworkActions.FILTER]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      await ensureSubscribed(debuggerMgr, tid);
      const includeResources = args.includeResources as boolean | undefined;
      // V2 P0 修复 D16: 字段名统一为 `pattern` (顶层 + filter 子字段一致)
      // 向后兼容: 旧字段名 `url` (line 305 原写法) 仍生效
      const urlPattern = (args.pattern ?? args.url) as string | undefined;
      const methodFilter = args.method as string | undefined;
      const statusMin = args.statusMin as number | undefined;
      const statusMax = args.statusMax as number | undefined;

      const apis = apiLogs.get(tid) ?? [];
      const source = includeResources
        ? [...apis, ...(resourceLogs.get(tid) ?? [])].sort((a, b) => a.startTime - b.startTime)
        : apis;

      return source.filter((l) => {
        if (urlPattern && !l.url.includes(urlPattern)) return false;
        if (methodFilter && l.method !== methodFilter.toUpperCase())
          return false;
        if (statusMin != null && (l.status == null || l.status < statusMin))
          return false;
        if (statusMax != null && (l.status == null || l.status > statusMax))
          return false;
        return true;
      });
    },

    [NetworkActions.CLEAR]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      apiLogs.delete(tid);
      resourceLogs.delete(tid);
      return { cleared: true, tabId: tid };
    },

    [NetworkActions.GET_RESPONSE_BODY]: async (args, tabId) => {
      const requestId = args.requestId as string;
      if (!requestId) throw vtxError(VtxErrorCode.INVALID_PARAMS, "requestId is required");
      const cached = responseBodies.get(requestId);
      if (cached) {
        return { requestId, body: cached.body, encoding: cached.encoding };
      }
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      await ensureSubscribed(debuggerMgr, tid);
      if (debuggerMgr.isAttached(tid)) {
        try {
          const result = await debuggerMgr.sendCommand(tid, "Network.getResponseBody", { requestId }) as any;
          return { requestId, body: result.body, encoding: result.base64Encoded ? "base64" : "text" };
        } catch {
          throw vtxError(
            VtxErrorCode.INTERNAL_ERROR,
            `Response body not available for ${requestId}`,
            { extras: { requestId } },
            { hint: "Response body may have been 204/redirect or evicted from cache. Trigger the request again (subscription is now active) and retry." },
          );
        }
      }
      throw vtxError(
        VtxErrorCode.INTERNAL_ERROR,
        `Response body not found for ${requestId}`,
        { extras: { requestId } },
        { hint: "Network subscription was just auto-activated; trigger the request and retry. If the requestId came from an earlier session, it has been evicted." },
      );
    },

    /**
     * 按 requestId 返回单请求的 status+statusText+headers+body（合并视图）。
     * status/statusText/headers 来自 responseReceived 事件缓存的 NetworkEntry；
     * body 来自 responseBodies 缓存（loadingFinished 后异步写入）或实时 CDP 调用。
     * body 超过 maxLength（默认 10240）时截断并标注 truncated:true。
     *
     * 前置依赖：此 handler 依赖 tab 已通过 source=network 查询而被订阅；
     * 若 tab 从未订阅，所有 entry 均为空（届时返回 not found 错误，
     * hint 引导调用方先调 source=network）。
     */
    [NetworkActions.GET_REQUEST_DETAIL]: async (args, tabId) => {
      const requestId = args.requestId as string | undefined;
      if (!requestId) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS, "requestId is required for source=request");
      }
      const maxLength = (args.maxLength as number | undefined) ?? 10240;
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);

      // 从 apiLogs 或 resourceLogs 中查找对应条目（携带 status/headers 元数据）
      const allEntries = [
        ...(apiLogs.get(tid) ?? []),
        ...(resourceLogs.get(tid) ?? []),
      ];
      const entry = allEntries.find((e) => e.requestId === requestId);
      if (!entry) {
        throw vtxError(
          VtxErrorCode.INTERNAL_ERROR,
          `Request not found: ${requestId}`,
          { extras: { requestId } },
          {
            hint:
              "The requestId was not found in the network log. " +
              "Use vortex_debug_read(source=network) to list requests and obtain a valid requestId. " +
              "Entries are evicted after the tab is closed or the log is cleared.",
          },
        );
      }

      // 获取 body：优先从 FIFO 缓存取，否则实时 CDP 调用。
      // encoding 必须一并回传(对齐 sibling getResponseBody):二进制响应 CDP 返
      // base64Encoded:true,body 是 base64 串。若丢弃此标志,agent 把 base64 当 text
      // 误读(实机复现 2026-06-20:image/png 响应 body=iVBORw0KGgo... 无信号)。
      let bodyRaw = "";
      let encoding = "text";
      const cachedBody = responseBodies.get(requestId);
      if (cachedBody) {
        bodyRaw = cachedBody.body;
        encoding = cachedBody.encoding;
      } else if (debuggerMgr.isAttached(tid)) {
        try {
          const result = await debuggerMgr.sendCommand(
            tid,
            "Network.getResponseBody",
            { requestId },
          ) as any;
          bodyRaw = result.body ?? "";
          encoding = result.base64Encoded ? "base64" : "text";
        } catch {
          // 204/重定向/body 已淘汰时静默回退空字符串
          bodyRaw = "";
        }
      }

      // body 截断。base64 须对齐 4 字符 quad 边界,否则尾部残缺 quad 让整段
      // atob 解码抛错(length%4==1 时必失败);对齐后返回前缀整段可解码。
      const truncated = bodyRaw.length > maxLength;
      const limit = encoding === "base64" ? maxLength - (maxLength % 4) : maxLength;
      const body = truncated ? bodyRaw.slice(0, limit) : bodyRaw;

      return {
        requestId,
        url: entry.url,
        method: entry.method,
        status: entry.status ?? null,
        statusText: entry.statusText ?? null,
        headers: entry.responseHeaders ?? {},
        body,
        encoding,
        truncated,
      };
    },
  });
}
