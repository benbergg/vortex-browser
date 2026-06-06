import { PageActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
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

// 等新文档 DOMContentLoaded（DOM 解析完成、可 query 可交互），不等全部子资源
// （load/tab 'complete'）。用 chrome.webNavigation.onDOMContentLoaded 主 frame 信号精确
// 捕获——tab 'complete' 反映所有网络活动,DOM 秒就绪的慢站(挂起 img/长尾资源)会被
// waitForTabLoad 拖到 ~25s 超时降级,而 caller 只要 DOM(NAV-1, 2026-06-04 审计)。
// 监听器须由 caller 在 chrome.tabs.update 之前挂上,消除快页面 DCL 早于监听的竞态。
//
// 双信号竞速取先:① onDOMContentLoaded(整页导航的早返回信号,慢站子资源未就绪也返回)
// ② tabs.onUpdated 'complete'(同文档/hash 导航**不 fire DCL**,但 tab 仍快速 complete——
// 没有此副信号,hash+domcontentloaded 会干等到超时,比旧 waitForTabLoad 还慢,reflexion
// 回归修复)。整页慢站:DCL 先到;hash:complete 先到;两者都覆盖。
// 超时优雅降级:探 readyState,interactive/complete → { degraded: true },仍 loading 才 reject。
function waitForDomReady(
  tabId: number,
  timeoutMs: number = 25_000,
): Promise<{ degraded: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      cleanup();
      const ready = await probeReadyState(tabId);
      if (ready === "interactive" || ready === "complete") {
        resolve({ degraded: true });
        return;
      }
      reject(vtxError(VtxErrorCode.TIMEOUT, `DOMContentLoaded timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      chrome.webNavigation.onDOMContentLoaded.removeListener(dclListener);
      chrome.tabs.onUpdated.removeListener(tabListener);
    }
    function dclListener(details: { tabId: number; frameId: number }) {
      // 只认目标 tab 的主 frame（frameId === 0）;子 frame DCL 不代表主文档就绪。
      if (details.tabId === tabId && details.frameId === 0) {
        cleanup();
        resolve({ degraded: false });
      }
    }
    function tabListener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      // 同文档/hash 导航无 DCL,以 tab 'complete' 作副信号快速返回。
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve({ degraded: false });
      }
    }
    chrome.webNavigation.onDOMContentLoaded.addListener(dclListener);
    chrome.tabs.onUpdated.addListener(tabListener);
  });
}

export { waitForDomReady };

// MCP 传输层（client.ts requestOnce）对每次工具调用有硬超时（VORTEX_TIMEOUT_MS，
// 默认 30s），到点直接向 caller 抛 "no response for page.navigate"。navigate 的内部
// load 等待若也用满 30s，传输层会以微弱差距先放弃，优雅降级（{degraded:true}）的响应
// 永远到不了 caller —— agent 仍见硬超时而非降级成功（DDG dogfood 2026-06-03 实测）。
// 故内部 load 等待要 < 传输超时，留 5s margin（25s）覆盖 readyState 探测 + WS 回程。
// 注：用户把 VORTEX_TIMEOUT_MS 调到 <25s 时仍可能被传输层先截断——属显式短预算选择。
const NAVIGATE_LOAD_TIMEOUT_MS = 25_000;

/**
 * CDP 历史导航:替代 chrome.tabs.goBack / goForward。
 *
 * chrome.tabs.goBack/goForward 受 Chrome history-manipulation intervention
 * 影响——扩展通过 chrome.tabs.update 发起(无页面内用户手势)的导航 entry 会被
 * 标记为「在 back/forward UI 中跳过」,导致 goBack 报原生错误 "Cannot find a
 * next page in history",即便 window.history 仍可后退(vortex_navigate 建立的
 * 历史尤其踩此坑,2026-06-06 e2e 确诊:同一 tab 同栈同位置,页面级 history.back()
 * 成功而扩展级 chrome.tabs.goBack 失败)。改用 CDP Page.getNavigationHistory +
 * Page.navigateToHistoryEntry 按 entryId 精确导航,绕过 UI-skip。delta=-1 后退、
 * +1 前进。已在栈底/顶时抛 NO_EFFECT —— 而非裸 Error 冒泡被 router 兜底成
 * JS_EXECUTION_ERROR + 误导的「调整 selector」hint。
 */
export async function navigateHistory(
  debuggerMgr: DebuggerManager,
  tid: number,
  delta: -1 | 1,
): Promise<void> {
  await debuggerMgr.attach(tid);
  const { currentIndex, entries } = (await debuggerMgr.sendCommand(
    tid,
    "Page.getNavigationHistory",
  )) as { currentIndex: number; entries: Array<{ id: number }> };
  const targetIndex = currentIndex + delta;
  if (targetIndex < 0 || targetIndex >= entries.length) {
    throw vtxError(
      VtxErrorCode.NO_EFFECT,
      delta < 0
        ? "Already at the oldest entry in history; cannot go back."
        : "Already at the newest entry in history; cannot go forward.",
      undefined,
      {
        hint: "No browser-history entry in that direction. Load a page directly with vortex_navigate(url).",
      },
    );
  }
  await debuggerMgr.sendCommand(tid, "Page.navigateToHistoryEntry", {
    entryId: entries[targetIndex].id,
  });
}

export function registerPageHandlers(router: ActionRouter, debuggerMgr: DebuggerManager): void {
  router.registerAll({
    [PageActions.NAVIGATE]: async (args, tabId) => {
      const url = args.url as string;
      if (!url) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: url");
      // BUG-006: URL 预校验 — 防御性白名单,避免无 scheme 误跳 chrome-extension://
      // 内部页,以及 javascript:/data: 等 XSS 风险。file:// 留给本地文件工作流。
      const ALLOWED_URL_SCHEMES = ["http:", "https:", "file:"];
      let parsed: URL;
      try { parsed = new URL(url); } catch {
        throw vtxError(VtxErrorCode.INVALID_PARAMS,
          `Invalid URL: ${url} (must start with http:// or https://)`);
      }
      if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS,
          `URL scheme not allowed: ${parsed.protocol} (must be one of ${ALLOWED_URL_SCHEMES.join(", ")})`);
      }
      const tid = await getActiveTabId(tabId);
      const waitForLoad = (args.waitForLoad as boolean) ?? true;
      // Public schema 暴露 waitUntil: load / domcontentloaded / networkidle。
      // 在 v0.8.1 之前 handler 完全忽略该字段（一律走 onload），但 schema 仍
      // 接受 networkidle 让调用方误以为生效 —— SPA 上 long-polling 永不 idle
      // 时即使等到 onload 完成，调用方仍以为 networkidle 没满足。
      // v0.8.1 之后：handler 显式读 waitUntil。
      //   - "load" / 缺省：等 tab 'complete'（waitForTabLoad）。
      //   - "domcontentloaded": 等新文档 DOMContentLoaded（waitForDomReady，主 frame
      //     webNavigation 信号）即返回,不等子资源(NAV-1, 2026-06-04 审计修复——此前与
      //     load 同走 waitForTabLoad,慢站 DOM 秒就绪仍阻塞 ~25s)。
      //   - "networkidle": 先等 tab 'complete'，再额外 awaitIdle（剩余预算,NAV-3）。
      //     超时不 throw 而是 console.warn 后 graceful 返回，避免 SPA long-polling
      //     把整个 navigate 拖死（P2-7, 2026-05-21）。
      const waitUntil = (args.waitUntil as string | undefined) ?? "load";
      const outerTimeout = (args.timeout as number) ?? 30_000;
      // 内层总 cap:load + 可选 networkidle 合计须 < 传输超时(NAVIGATE_LOAD_TIMEOUT_MS
      // 已 < 30s)。idle 阶段从此 cap 扣减 load 已耗,而非另叠固定 5s(NAV-3)。
      const innerCap = Math.min(outerTimeout, NAVIGATE_LOAD_TIMEOUT_MS);
      const navStart = Date.now();
      // NAV-1:domcontentloaded 的 DCL 监听器须在 tabs.update 之前挂上——DCL 事件可能在
      // 导航提交后极快 fire,晚挂会漏掉而干等到超时。
      const dclPromise =
        waitForLoad && waitUntil === "domcontentloaded"
          ? waitForDomReady(tid, innerCap)
          : null;
      // NAV-1b:load/networkidle 的 tab 'complete' 监听器同样须在 tabs.update 之前挂——
      // hash/同文档导航近乎瞬时 complete,监听器晚挂会漏掉瞬时 'complete' 而干等满 25s
      // (竞态偶发,2026-06-04 插桩确诊 load 模式 55ms↔25047ms 抖动)。对齐 dclPromise 的
      // NAV-1 修复;此前 load 路径在 update 后才挂 waitForTabLoad,是默认路径漏修的死角。
      const loadPromise =
        waitForLoad && waitUntil !== "domcontentloaded"
          ? waitForTabLoad(tid, innerCap)
          : null;
      await chrome.tabs.update(tid, { url });
      let degraded = false;
      if (waitForLoad) {
        if (waitUntil === "domcontentloaded") {
          // DOM 解析完成即返回,不等子资源(NAV-1)。dclPromise 已在 update 前挂好监听。
          ({ degraded } = await dclPromise!);
          const tab = await chrome.tabs.get(tid);
          return { url: tab.url, title: tab.title, status: tab.status, ...(degraded ? { degraded: true } : {}) };
        }
        // load / networkidle 走 waitForTabLoad（等 tab 'complete'）；超时时若 DOM 已就绪
        // 则优雅降级返回（degraded: true），仅 DOM 仍 loading 才 throw。内部 load 等待 cap
        // 在 NAVIGATE_LOAD_TIMEOUT_MS（< 传输超时），确保降级响应能回到 caller。
        // loadPromise 已在 update 前挂好监听消除 hash 竞态(NAV-1b)。
        ({ degraded } = await loadPromise!);
        if (waitUntil === "networkidle") {
          // NAV-3:idle 超时用剩余预算(innerCap - load 已耗),而非硬编码 5000 叠加在
          // load 之上 → load 慢站(~25s)+ idle 5s ≈ 30s 吃光传输 margin(flaky)。
          // floor 1s 保证即便 load 用满预算 idle 仍有片刻探测窗口(1s << buffer,不破 margin)。
          const elapsed = Date.now() - navStart;
          const idleTimeout = Math.max(1_000, innerCap - elapsed);
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
      // 内部 load 等待 cap 在 NAVIGATE_LOAD_TIMEOUT_MS(< 传输 30s):裸 waitForTabLoad
      // (tid) 默认 30s == 传输超时,慢站降级响应到不了 caller(同 navigate 第二层
      // 根因,2026-06-04 审计)。degraded 标记一并 surface,与 navigate 对齐。
      const { degraded } = await waitForTabLoad(tid, NAVIGATE_LOAD_TIMEOUT_MS);
      const tab = await chrome.tabs.get(tid);
      return { url: tab.url, title: tab.title, ...(degraded ? { degraded: true } : {}) };
    },

    [PageActions.BACK]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      await navigateHistory(debuggerMgr, tid, -1);
      const { degraded } = await waitForTabLoad(tid, NAVIGATE_LOAD_TIMEOUT_MS);
      const tab = await chrome.tabs.get(tid);
      return { url: tab.url, title: tab.title, ...(degraded ? { degraded: true } : {}) };
    },

    [PageActions.FORWARD]: async (args, tabId) => {
      const tid = await getActiveTabId(tabId);
      await navigateHistory(debuggerMgr, tid, 1);
      const { degraded } = await waitForTabLoad(tid, NAVIGATE_LOAD_TIMEOUT_MS);
      const tab = await chrome.tabs.get(tid);
      return { url: tab.url, title: tab.title, ...(degraded ? { degraded: true } : {}) };
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
        // 默认 cap 在 NAVIGATE_LOAD_TIMEOUT_MS(< 传输 30s):idle 超时是 reject(非
        // 优雅降级),默认 30s == 传输会让 TIMEOUT 被传输层 "no response" 抢先
        // (2026-06-04 审计)。用户显式传更长值仍尊重(须同步抬 VORTEX_TIMEOUT_MS)。
        timeout: (args.timeout as number) ?? NAVIGATE_LOAD_TIMEOUT_MS,
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
              // BUG-004: detect IIFE forms and auto-invoke. Without this,
              // `() => false` is `eval`-ed to an arrow function (truthy!) and
              // `if (v)` immediately resolves, defeating "wait until X" semantics.
              const isIIFE = /^\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(expr)
                || /^\s*(?:async\s+)?function\s*[*(]/.test(expr);
              const tryOnce = () => {
                try {
                  const v = isIIFE ? eval('(' + expr + ')()') : eval(expr);
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
