// L1 Page-side Bundle Loader: inject page-side bundle into target tab+frame MAIN world
// via chrome.scripting.executeScript({ files }).
//
// Design:
// - Idempotent: maintain (tabId, frameId, module) loaded set, repeated calls are no-op
// - Concurrent-safe: in-flight promise is stored so parallel callers await the same execution
// - MAIN world: same as PR #1 pageQuery to avoid framework isolation
// - module names centralized to avoid typos and aid grep

import { buildExecuteTarget } from "../lib/tab-utils.js";

export type PageSideModule =
  | "actionability"
  | "fill-reject"
  | "commit-checkbox-group"
  | "commit-select"
  | "commit-aria-select"
  | "dom-resolve"
  | "click-effect";

const loadedModules = new Map<string, true | Promise<void>>();

// 注入超时(ms)。chrome.scripting.executeScript 在某些 SW/tab 异常态(SW 被回收后
// 重启、跨进程导航中途、renderer 卡顿)下会**永不 settle**(既不 resolve 也不 reject)。
// 下方把 in-flight promise 缓存,一旦它永久 pending,所有 await 它的后续调用同样永久
// 挂——把一次瞬时卡顿放大成永久 wedge(observe 走 executeScript({func}) 无此缓存故
// 始终正常,dom.* 经 loadPageSideModule 则全挂,且仅 SW 重启才恢复)。加超时:超时
// 即 reject → 触发下方 .catch 驱逐缓存 → 下次调用可重试;调用方(auto-wait)因此拿到
// 有界、可恢复的错误而非 30s 静默挂(2026-06-02 saucedemo dogfood 系统化调查定位)。
// 取 3000ms:正常注入(已加载页面)<100ms,30x 余量不会误超时;且**须明显低于**
// 上层 waitActionable 的 5000ms 预算(auto-wait.ts),否则卡住的注入会烧完整个
// actionability 预算才失败(评审 MEDIUM)。注入超时以独立错误向上抛出(经
// checkActionability→waitActionable 传播),非泛化 TIMEOUT,失败原因清晰可辨。
const INJECT_TIMEOUT_MS = 3000;

function key(tabId: number, frameId: number | undefined, module: PageSideModule): string {
  return `${tabId}::${frameId ?? "top"}::${module}`;
}

/**
 * executeScript 注入与超时竞速。executeScript 永不 settle 时,超时分支 reject,
 * 把无界等待转成有界、可恢复的失败。无论哪边先 settle 都清理定时器避免泄漏。
 */
function injectWithTimeout(
  target: ReturnType<typeof buildExecuteTarget>,
  module: PageSideModule,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exec = chrome.scripting
    .executeScript({ target, files: [`page-side/${module}.js`], world: "MAIN" })
    .then(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `page-side module "${module}" injection timed out after ${INJECT_TIMEOUT_MS}ms ` +
            `(target tab likely in a bad SW/navigation state); cache evicted, retryable`,
        ),
      );
    }, INJECT_TIMEOUT_MS);
  });
  return Promise.race([exec, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function loadPageSideModule(
  tabId: number,
  frameId: number | undefined,
  module: PageSideModule,
): Promise<void> {
  const k = key(tabId, frameId, module);
  const cached = loadedModules.get(k);
  if (cached === true) return;
  if (cached !== undefined) {
    // in-flight — await the same promise
    await cached;
    return;
  }

  const target = buildExecuteTarget(tabId, frameId);
  const promise = injectWithTimeout(target, module)
    .then(() => {
      loadedModules.set(k, true);
    })
    .catch((err: unknown) => {
      // 失败(注入错误或超时)即驱逐 in-flight 缓存,使后续调用能重试——避免
      // 永久 pending promise 把瞬时卡顿放大成永久 wedge(2026-06-02 调查)。
      loadedModules.delete(k);
      throw err;
    });

  loadedModules.set(k, promise);
  await promise;
}

export function _resetPageSideLoader(): void {
  loadedModules.clear();
}

// Tab cleanup: clear cache entries when a tab closes during this SW lifetime.
// SW restarts already empty `loadedModules`, so this listener only handles
// in-session tab closures (preventing unbounded growth on long-lived SWs).
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const k of Array.from(loadedModules.keys())) {
      if (k.startsWith(`${tabId}::`)) loadedModules.delete(k);
    }
  });
}

// Navigation cleanup: a committed navigation discards window globals on the
// target frame, so any previously-injected page-side bundle (e.g. the IIFE on
// `window.__vortexActionability`) is gone. Without this listener `loadedModules`
// would still claim the bundle is "loaded" and the next actionability probe
// returns NOT_ATTACHED — observed during v0.6 dogfood (run 2 of github-star
// after a `vortex_navigate`, see PR #5 dogfood notes).
//
// Main-frame nav purges the whole tab (subframes go away with the parent
// document); subframe nav purges only that frameId's entries.
if (typeof chrome !== "undefined" && chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    const { tabId, frameId } = details;
    if (frameId === 0) {
      for (const k of Array.from(loadedModules.keys())) {
        if (k.startsWith(`${tabId}::`)) loadedModules.delete(k);
      }
    } else {
      const prefix = `${tabId}::${frameId}::`;
      for (const k of Array.from(loadedModules.keys())) {
        if (k.startsWith(prefix)) loadedModules.delete(k);
      }
    }
  });
}
