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

// 探一次目标 tab 的 document.readyState（仅主 frame）。executeScript 异常时返回
// 空串，调用方按"未就绪"处理。
async function probeReadyState(tabId: number): Promise<string> {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.readyState,
    });
    return (res[0]?.result as string | undefined) ?? "";
  } catch {
    return "";
  }
}

// 等 tab 加载完成。监听 chrome.tabs.onUpdated 的 status === "complete"——这是 **tab
// 级**加载态，反映**所有**网络活动（图片/广告/tracker/持久连接）。真实站 `load`
// 等所有子资源，常态 >30s 甚至永不触发（DDG dogfood 2026-06-03）。
//
// 超时优雅降级：load 超时不代表页面不可用。超时时探一次 document.readyState——若已
// `interactive`/`complete`（DOM 已解析、可 query 可交互），解析为 { degraded: true }
// 让 navigate 成功返回（附 degraded 标记），agent 可继续 observe/act，而非硬 throw
// 把 agent 困死。仅 DOM 仍 `loading`（真未就绪）才 reject TIMEOUT。与 networkidle
// 路径的优雅降级语义保持一致。
function waitForTabLoad(
  tabId: number,
  timeoutMs: number = 30_000,
): Promise<{ degraded: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      const ready = await probeReadyState(tabId);
      if (ready === "interactive" || ready === "complete") {
        resolve({ degraded: true });
        return;
      }
      reject(vtxError(VtxErrorCode.TIMEOUT, `Navigation timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ degraded: false });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export { waitForTabLoad };

// MCP 传输层（client.ts requestOnce）对每次工具调用有硬超时（VORTEX_TIMEOUT_MS，
// 默认 30s），到点直接向 caller 抛 "no response for page.navigate"。navigate 的内部
// load 等待若也用满 30s，传输层会以微弱差距先放弃，优雅降级（{degraded:true}）的响应
// 永远到不了 caller —— agent 仍见硬超时而非降级成功（DDG dogfood 2026-06-03 实测）。
// 故内部 load 等待要 < 传输超时，留 5s margin（25s）覆盖 readyState 探测 + WS 回程。
// 注：用户把 VORTEX_TIMEOUT_MS 调到 <25s 时仍可能被传输层先截断——属显式短预算选择。
const NAVIGATE_LOAD_TIMEOUT_MS = 25_000;

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
      let degraded = false;
      if (waitForLoad) {
        // load / domcontentloaded 都走 waitForTabLoad；超时时若 DOM 已就绪则优雅降级
        // 返回（degraded: true），仅 DOM 仍 loading 才 throw。内部 load 等待 cap 在
        // NAVIGATE_LOAD_TIMEOUT_MS（< 传输超时），确保降级响应能回到 caller。
        const loadWait = Math.min(outerTimeout, NAVIGATE_LOAD_TIMEOUT_MS);
        ({ degraded } = await waitForTabLoad(tid, loadWait));
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
      return {
        url: tab.url,
        title: tab.title,
        status: tab.status,
        ...(degraded ? { degraded: true } : {}),
      };
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

    [PageActions.WAIT_FOR_EXPRESSION]: async (args, tabId) => {
      const expression = args.expression as string;
      if (!expression) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: expression");
      const tid = await getActiveTabId(tabId);
      const timeout = (args.timeout as number) ?? 10_000;
      const pollInterval = (args.pollInterval as number) ?? 100;
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        // page-side polling: requestAnimationFrame for the visible-update phase,
        // setTimeout for the inter-poll gap. Stops on first truthy value or on
        // timeout. Returns { ok, value, waitedMs, error? } so the caller can
        // distinguish "expr threw" from "expr never went truthy".
        func: (expr: string, timeoutMs: number, intervalMs: number) => {
          return new Promise<{ ok: boolean; value?: unknown; waitedMs: number; error?: string }>(
            (resolve) => {
              const start = Date.now();
              let lastError: string | undefined;
              const tryOnce = () => {
                try {
                  const v = eval(expr);
                  if (v) {
                    resolve({ ok: true, value: v as unknown, waitedMs: Date.now() - start });
                    return true;
                  }
                } catch (err) {
                  lastError = err instanceof Error ? err.message : String(err);
                }
                return false;
              };
              if (tryOnce()) return;
              const poll = () => {
                if (tryOnce()) return;
                if (Date.now() - start >= timeoutMs) {
                  resolve({ ok: false, waitedMs: Date.now() - start, error: lastError });
                  return;
                }
                setTimeout(() => requestAnimationFrame(poll), intervalMs);
              };
              setTimeout(() => requestAnimationFrame(poll), intervalMs);
            },
          );
        },
        args: [expression, timeout, pollInterval],
        world: "MAIN",
      });
      const res = results[0]?.result as
        | { ok: boolean; value?: unknown; waitedMs: number; error?: string }
        | undefined;
      if (!res) throw vtxError(VtxErrorCode.INTERNAL_ERROR, "waitForExpression returned no result", { tabId: tid, frameId });
      if (!res.ok) {
        throw vtxError(
          VtxErrorCode.TIMEOUT,
          res.error
            ? `Expression never resolved truthy within ${timeout}ms; last evaluation threw: ${res.error}`
            : `Expression never resolved truthy within ${timeout}ms`,
          { tabId: tid, frameId, extras: { expression, waitedMs: res.waitedMs, lastError: res.error } },
        );
      }
      return { ready: true, value: res.value, waitedMs: res.waitedMs };
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
