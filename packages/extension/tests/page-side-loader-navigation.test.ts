import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Regression for the v0.6 dogfood Bug E: page-side-loader cached
// "loaded=true" forever, so a chrome navigation discarded
// window.__vortexActionability but the next loadPageSideModule call still
// short-circuited and the actionability probe wrapper returned NOT_ATTACHED
// for the entire 5 s retry loop. Fix: subscribe to
// chrome.webNavigation.onCommitted and evict matching cache entries.

interface NavListener {
  (details: { tabId: number; frameId: number }): void;
}
interface TabListener {
  (tabId: number): void;
}

let executeScriptMock: Mock;
let onCommittedFire: NavListener;
let onRemovedFire: TabListener;

async function importLoaderWithFreshChrome() {
  vi.resetModules();
  executeScriptMock = vi.fn().mockResolvedValue([{ result: undefined }]);

  let committedCb: NavListener | undefined;
  let removedCb: TabListener | undefined;

  (globalThis as any).chrome = {
    scripting: { executeScript: executeScriptMock },
    tabs: {
      onRemoved: {
        addListener: vi.fn((cb: TabListener) => {
          removedCb = cb;
        }),
      },
    },
    webNavigation: {
      onCommitted: {
        addListener: vi.fn((cb: NavListener) => {
          committedCb = cb;
        }),
      },
    },
  };

  const mod = await import("../src/adapter/page-side-loader.js");
  if (!committedCb) throw new Error("loader did not register webNavigation listener");
  if (!removedCb) throw new Error("loader did not register tabs.onRemoved listener");
  onCommittedFire = committedCb;
  onRemovedFire = removedCb;
  return mod;
}

describe("page-side-loader navigation cache invalidation (Bug E)", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
  });

  it("repeat load on cached entry skips chrome.scripting.executeScript", async () => {
    const { loadPageSideModule } = await importLoaderWithFreshChrome();
    await loadPageSideModule(100, undefined, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    executeScriptMock.mockClear();
    await loadPageSideModule(100, undefined, "actionability");
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  it("main-frame navigation evicts every cache entry for that tab", async () => {
    const { loadPageSideModule } = await importLoaderWithFreshChrome();
    await loadPageSideModule(100, undefined, "actionability");
    await loadPageSideModule(100, undefined, "fill-reject");
    await loadPageSideModule(200, undefined, "actionability");
    executeScriptMock.mockClear();

    onCommittedFire({ tabId: 100, frameId: 0 });

    // Both entries on tab 100 must re-inject; tab 200 stays cached.
    await loadPageSideModule(100, undefined, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    await loadPageSideModule(100, undefined, "fill-reject");
    expect(executeScriptMock).toHaveBeenCalledTimes(2);
    await loadPageSideModule(200, undefined, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(2);
  });

  it("subframe navigation evicts only that frameId, leaves siblings cached", async () => {
    const { loadPageSideModule } = await importLoaderWithFreshChrome();
    await loadPageSideModule(100, 0, "actionability");
    await loadPageSideModule(100, 5, "actionability");
    executeScriptMock.mockClear();

    onCommittedFire({ tabId: 100, frameId: 5 });

    await loadPageSideModule(100, 5, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    await loadPageSideModule(100, 0, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
  });

  it("executeScript 永不 settle 时超时 reject + 驱逐缓存,后续调用可重试(2026-06-02 wedge 调查)", async () => {
    // 根因:chrome.scripting.executeScript 在 SW/tab 异常态下会永不 settle。
    // 旧代码把该 pending promise 缓存,后续每次 await 同样永久挂——把瞬时卡顿放大
    // 成永久 wedge(仅 SW 重启才恢复)。修复:注入超时 → reject → 驱逐缓存 → 可重试。
    vi.useFakeTimers();
    try {
      const { loadPageSideModule } = await importLoaderWithFreshChrome();
      // 第一次:executeScript 永不 settle。
      executeScriptMock.mockReturnValueOnce(new Promise(() => {}));

      const first = loadPageSideModule(100, undefined, "actionability");
      // 防 unhandledRejection 噪声:挂一个 catch,断言留给下方。
      const firstSettled = first.then(
        () => "resolved",
        (e: Error) => e.message,
      );
      // 推进到超时点(INJECT_TIMEOUT_MS=3000,须低于 waitActionable 5000 预算;
      // 并冲洗微任务)。
      await vi.advanceTimersByTimeAsync(3000);
      const outcome = await firstSettled;
      expect(outcome).toContain("timed out");

      // 缓存已驱逐:第二次调用应**重新**注入(不是短路命中陈旧 pending promise)。
      executeScriptMock.mockResolvedValueOnce([{ result: undefined }]);
      executeScriptMock.mockClear();
      await loadPageSideModule(100, undefined, "actionability");
      expect(executeScriptMock).toHaveBeenCalledTimes(1);

      // 第三次:已成功加载 → 命中缓存,不再注入。
      executeScriptMock.mockClear();
      await loadPageSideModule(100, undefined, "actionability");
      expect(executeScriptMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tabs.onRemoved still evicts entire tab (existing behaviour preserved)", async () => {
    const { loadPageSideModule } = await importLoaderWithFreshChrome();
    await loadPageSideModule(100, undefined, "actionability");
    await loadPageSideModule(100, 5, "actionability");
    await loadPageSideModule(200, undefined, "actionability");
    executeScriptMock.mockClear();

    onRemovedFire(100);

    await loadPageSideModule(100, undefined, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
    await loadPageSideModule(100, 5, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(2);
    await loadPageSideModule(200, undefined, "actionability");
    expect(executeScriptMock).toHaveBeenCalledTimes(2);
  });
});
