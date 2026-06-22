// packages/extension/src/handlers/console.ts

import { ConsoleActions, VtxErrorCode, vtxError, VtxEventType } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import type { NativeMessagingClient } from "../lib/native-messaging.js";
import type { EventDispatcher } from "../events/dispatcher.js";

interface ConsoleEntry {
  level: string; // "log" | "warn" | "error" | "info" | "debug"
  text: string;
  args?: unknown[];
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  timestamp: number;
}

// 每个 tab 的 console 日志缓存（扩展侧）
const consoleLogs = new Map<number, ConsoleEntry[]>();
const MAX_LOGS = 500;
// 已订阅 console 的 tab
const subscribedTabs = new Set<number>();

async function getActiveTabId(tabId?: number): Promise<number> {
  if (tabId) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw vtxError(VtxErrorCode.TAB_NOT_FOUND, "No active tab found");
  return tab.id;
}

function addLog(tabId: number, entry: ConsoleEntry): void {
  if (!consoleLogs.has(tabId)) {
    consoleLogs.set(tabId, []);
  }
  const logs = consoleLogs.get(tabId)!;
  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }
}

/**
 * 将 CDP Runtime.RemoteObject 转为可序列化的值
 */
function remoteObjectToValue(obj: any): unknown {
  if (obj.type === "string") return obj.value;
  if (obj.type === "number") return obj.value;
  if (obj.type === "boolean") return obj.value;
  if (obj.type === "undefined") return undefined;
  if (obj.subtype === "null") return null;
  if (obj.type === "object" && obj.preview) {
    // 尝试从 preview 构建对象
    const result: Record<string, unknown> = {};
    if (obj.preview.properties) {
      for (const prop of obj.preview.properties) {
        result[prop.name] = prop.value;
      }
    }
    return result;
  }
  // fallback: 描述字符串
  return obj.description ?? obj.value ?? `[${obj.type}]`;
}

export function registerConsoleHandlers(
  router: ActionRouter,
  debuggerMgr: DebuggerManager,
  nm: NativeMessagingClient,
  dispatcher: EventDispatcher,
): void {
  // 监听 CDP Runtime 事件
  debuggerMgr.onEvent((tabId, method, params: any) => {
    if (!subscribedTabs.has(tabId)) return;

    if (method === "Runtime.consoleAPICalled") {
      const entry: ConsoleEntry = {
        level: params.type, // "log", "warning", "error", "info", "debug"
        text: (params.args ?? [])
          .map((a: any) => {
            const val = remoteObjectToValue(a);
            return typeof val === "string" ? val : JSON.stringify(val);
          })
          .join(" "),
        args: (params.args ?? []).map(remoteObjectToValue),
        timestamp: Date.now(),
      };
      // CDP 用 "warning" 表示 console.warn
      if (entry.level === "warning") entry.level = "warn";

      addLog(tabId, entry);

      // 去重分流（F3）：error 级仅走 CONSOLE_ERROR，
      // 非 error 级保留 legacy console.message 兼容已有消费者。
      if (entry.level === "error") {
        dispatcher.emit(VtxEventType.CONSOLE_ERROR, entry, { tabId });
      } else {
        nm.send({
          type: "event",
          event: "console.message",
          data: entry,
          tabId,
        });
      }
    }

    if (method === "Runtime.exceptionThrown") {
      const exDetail = params.exceptionDetails;
      const entry: ConsoleEntry = {
        level: "error",
        text:
          exDetail?.exception?.description ??
          exDetail?.text ??
          "Unknown exception",
        url: exDetail?.url ?? null,
        lineNumber: exDetail?.lineNumber ?? null,
        columnNumber: exDetail?.columnNumber ?? null,
        timestamp: Date.now(),
      };

      addLog(tabId, entry);

      // 异常一定是 error 级：仅走 CONSOLE_ERROR，不再重发 legacy。
      dispatcher.emit(VtxEventType.CONSOLE_ERROR, entry, { tabId });
    }
  });

  // tab 关闭时清理
  chrome.tabs.onRemoved.addListener((tabId) => {
    consoleLogs.delete(tabId);
    subscribedTabs.delete(tabId);
  });

  // Idempotent CDP Runtime subscription. Pulled out of the SUBSCRIBE
  // handler body so GET_LOGS / GET_ERRORS can lazy-subscribe — the
  // public `vortex_debug_read(source=console)` tool dispatches to
  // GET_LOGS without ever passing through SUBSCRIBE, so without this
  // lazy-attach the cache stayed empty and the tool always returned
  // []. Mirrors network.ts ensureSubscribed.
  async function ensureSubscribed(tid: number): Promise<void> {
    if (subscribedTabs.has(tid)) return;
    await debuggerMgr.enableDomain(tid, "Runtime");
    subscribedTabs.add(tid);
  }

  router.registerAll({
    [ConsoleActions.SUBSCRIBE]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      await ensureSubscribed(tid);
      return { subscribed: true, tabId: tid };
    },

    [ConsoleActions.GET_LOGS]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      await ensureSubscribed(tid);
      const level = args.level as string | undefined;
      let logs = consoleLogs.get(tid) ?? [];
      // 'all' 是文档化的「全部级别」哨兵(dispatch.ts:214,vortex_debug_read
      // filter.level='error'|'warn'|'all')。没有 entry 的 level 字面为 'all',
      // 当作具体级别过滤会让「请求全部日志」静默返回 [](silent-false-negative)。
      // 故 'all' 视作无级别过滤(同时覆盖 vortex_console 与 vortex_debug_read)。
      if (level && level !== "all") {
        logs = logs.filter((l) => l.level === level);
      }
      // tail(dispatch 把 debug_read 顶层 tail 写成 limit):取末 N 条 = 最近 N 条日志。
      // 文档化但此前 getLogs 漏读 → tail=N 求最近 N 却返回全部(silent no-op,与 network
      // getLogs 同类,2026-06-20)。
      const limit = args.limit as number | undefined;
      if (limit != null && limit >= 0 && logs.length > limit) {
        logs = logs.slice(logs.length - limit);
      }
      return logs;
    },

    [ConsoleActions.GET_ERRORS]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      await ensureSubscribed(tid);
      const logs = consoleLogs.get(tid) ?? [];
      return logs.filter((l) => l.level === "error");
    },

    [ConsoleActions.CLEAR]: async (args, tabId) => {
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      consoleLogs.delete(tid);
      return { cleared: true, tabId: tid };
    },
  });
}
