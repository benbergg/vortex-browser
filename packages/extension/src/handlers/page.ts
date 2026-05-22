import { PageActions, VtxErrorCode, vtxError } from "@bytenew/vortex-shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";

async function getActiveTabId(tabId?: number): Promise<number> {
  if (tabId) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw vtxError(VtxErrorCode.TAB_NOT_FOUND, "No active tab found");
  return tab.id;
}

function waitForTabLoad(tabId: number, timeoutMs: number = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(vtxError(VtxErrorCode.TIMEOUT, `Navigation timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export function registerPageHandlers(router: ActionRouter, debuggerMgr: DebuggerManager): void {
  router.registerAll({
    [PageActions.NAVIGATE]: async (args, tabId) => {
      const url = args.url as string;
      if (!url) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: url");
      const tid = await getActiveTabId(tabId);
      const waitForLoad = (args.waitForLoad as boolean) ?? true;
      // Public schema 暴露 waitUntil: load / domcontentloaded / networkidle。
      // 在 v0.8.1 之前 handler 完全忽略该字段（一律走 onload），但 schema 仍
      // 接受 networkidle 让调用方误以为生效 —— SPA 上 long-polling 永不 idle
      // 时即使等到 onload 完成，调用方仍以为 networkidle 没满足。
      // v0.8.1 之后：handler 显式读 waitUntil。
      //   - "load" / 缺省：当前 onload 行为。
      //   - "domcontentloaded": 等 status === "loading" 后立刻返回。
      //   - "networkidle": 先等 onload，再额外 awaitIdle（内部 5s 上限）。
      //     超 5s 不 throw 而是 console.warn 后 graceful 返回，避免 SPA
      //     long-polling 把整个 navigate 拖死（P2-7, 2026-05-21）。
      const waitUntil = (args.waitUntil as string | undefined) ?? "load";
      const outerTimeout = (args.timeout as number) ?? 30_000;
      await chrome.tabs.update(tid, { url });
      if (waitForLoad) {
        if (waitUntil === "domcontentloaded") {
          // Chrome tabs API 不直接暴露 DOMContentLoaded，用 readyState 轮询
          // 一次即可（status 转 loading 后 DOM 已可访问）。fallback 至 load。
          try {
            await waitForTabLoad(tid, outerTimeout);
          } catch (err) {
            // domcontentloaded 不应该比 load 更严格
            throw err;
          }
        } else {
          await waitForTabLoad(tid, outerTimeout);
        }
        if (waitUntil === "networkidle") {
          const idleTimeout = 5_000;
          try {
            await awaitIdle(debuggerMgr, tid, { timeout: idleTimeout, idleTime: 500 });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // graceful 降级：保留 navigate 成功语义
            console.warn(`[vortex] navigate waitUntil=networkidle degraded to load after ${idleTimeout}ms: ${msg}`);
          }
        }
      }
      const tab = await chrome.tabs.get(tid);
      return { url: tab.url, title: tab.title, status: tab.status };
    },

    [PageActions.RELOAD]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      await chrome.tabs.reload(tid);
      await waitForTabLoad(tid);
      const tab = await chrome.tabs.get(tid);
      return { url: tab.url, title: tab.title };
    },

    [PageActions.BACK]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      await chrome.tabs.goBack(tid);
      await waitForTabLoad(tid);
      const tab = await chrome.tabs.get(tid);
      return { url: tab.url, title: tab.title };
    },

    [PageActions.FORWARD]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      await chrome.tabs.goForward(tid);
      await waitForTabLoad(tid);
      const tab = await chrome.tabs.get(tid);
      return { url: tab.url, title: tab.title };
    },

    [PageActions.WAIT]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      const selector = args.selector as string | undefined;
      const timeout = (args.timeout as number) ?? 10_000;

      if (selector) {
        const frameId = args.frameId as number | undefined;
        if (frameId != null) await ensureFrameAttached(tid, frameId);
        const result = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: (sel: string, ms: number) => {
            return new Promise<boolean>((resolve) => {
              if (document.querySelector(sel)) { resolve(true); return; }
              const observer = new MutationObserver(() => {
                if (document.querySelector(sel)) { observer.disconnect(); resolve(true); }
              });
              observer.observe(document.body, { childList: true, subtree: true });
              setTimeout(() => { observer.disconnect(); resolve(false); }, ms);
            });
          },
          args: [selector, timeout],
        });
        const found = result[0]?.result;
        if (!found) throw vtxError(VtxErrorCode.TIMEOUT, `Selector "${selector}" not found within ${timeout}ms`, { selector });
        return { found: true, selector };
      }

      await new Promise((r) => setTimeout(r, timeout));
      return { waited: timeout };
    },

    [PageActions.INFO]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      const tab = await chrome.tabs.get(tid);
      const base = { url: tab.url, title: tab.title, status: tab.status, tabId: tab.id, windowId: tab.windowId };
      if (!args?.includeAllTabs) return base;
      const all = await chrome.tabs.query({});
      const tabs = all.map((t) => ({ tabId: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active }));
      return { ...base, tabs };
    },

    [PageActions.WAIT_FOR_NETWORK_IDLE]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      return awaitIdle(debuggerMgr, tid, {
        timeout: (args.timeout as number) ?? 30_000,
        idleTime: (args.idleTime as number) ?? 500,
        urlPattern: args.urlPattern as string | undefined,
        requestTypes: args.requestTypes as string[] | undefined,
        minRequests: (args.minRequests as number | undefined) ?? 0,
      });
    },

    [PageActions.WAIT_FOR_XHR_IDLE]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      // XHR idle 语义：只盯 XHR+Fetch，忽略 WS / 静态资源。idle 默认更短（200ms）贴 SPA 反馈。
      return awaitIdle(debuggerMgr, tid, {
        timeout: (args.timeout as number) ?? 10_000,
        idleTime: (args.idleTime as number) ?? 200,
        urlPattern: args.urlPattern as string | undefined,
        requestTypes: ["XHR", "Fetch"],
        minRequests: (args.minRequests as number | undefined) ?? 0,
      });
    },
  });
}

interface AwaitIdleOpts {
  timeout: number;
  idleTime: number;
  /** 只盯 URL 包含该子串的请求。默认不过滤。 */
  urlPattern?: string;
  /** CDP Network.requestWillBeSent 的 type 白名单，如 ["XHR","Fetch"]。默认不过滤。 */
  requestTypes?: string[];
  /** 至少看到 N 个匹配请求发起过才允许 resolve（防止空操作瞬间误判 idle）。默认 0。 */
  minRequests?: number;
}

/**
 * 通用网络 idle 等待。抽离自 WAIT_FOR_NETWORK_IDLE，供它和 WAIT_FOR_XHR_IDLE 复用。
 *
 * 实现要点：
 * - 只对**通过过滤**的 requestWillBeSent 递增 pending，并把 requestId 放进 set。
 * - loadingFinished/Failed 必须检查 requestId 是否在 set 中，才递减——避免"filter 掉的请求也减数"导致 pending<0 的幽灵 idle。
 * - resolve 条件：(a) pending=0 且已满足 minRequests (b) 最近 idleTime ms 内无新发起。
 */
async function awaitIdle(
  debuggerMgr: DebuggerManager,
  tid: number,
  opts: AwaitIdleOpts,
): Promise<{ idle: true; waitedMs: number; matchedRequests: number }> {
  await debuggerMgr.enableDomain(tid, "Network");
  const { timeout, idleTime, urlPattern, requestTypes, minRequests = 0 } = opts;
  const typeSet = requestTypes ? new Set(requestTypes) : null;

  return new Promise((resolve, reject) => {
    const tracked = new Set<string>();
    let matched = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const startTime = Date.now();

    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(
        vtxError(
          VtxErrorCode.TIMEOUT,
          `Network not idle after ${timeout}ms (${tracked.size} matching requests pending, ${matched} seen)`,
          { extras: { pending: tracked.size, matched, urlPattern, requestTypes } },
        ),
      );
    }, timeout);

    function checkIdle(): void {
      if (tracked.size <= 0 && matched >= minRequests) {
        idleTimer = setTimeout(() => {
          cleanup();
          resolve({ idle: true, waitedMs: Date.now() - startTime, matchedRequests: matched });
        }, idleTime);
      }
    }

    function onEvent(evtTabId: number, method: string, params: unknown): void {
      if (evtTabId !== tid) return;
      const p = params as {
        requestId?: string;
        request?: { url?: string };
        type?: string;
      };
      if (method === "Network.requestWillBeSent") {
        const reqId = p.requestId;
        const url = p.request?.url ?? "";
        const type = p.type ?? "";
        if (!reqId) return;
        if (urlPattern && !url.includes(urlPattern)) return;
        if (typeSet && !typeSet.has(type)) return;
        tracked.add(reqId);
        matched++;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      } else if (
        method === "Network.loadingFinished" ||
        method === "Network.loadingFailed"
      ) {
        const reqId = p.requestId;
        if (!reqId || !tracked.has(reqId)) return;
        tracked.delete(reqId);
        checkIdle();
      }
    }

    function cleanup(): void {
      clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      debuggerMgr.offEvent(onEvent);
    }

    debuggerMgr.onEvent(onEvent);
    // 立即检查：如果当前没有进行中的匹配请求且无最小数量要求，直接开始 idle 计时
    checkIdle();
  });
}
