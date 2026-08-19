import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ActionRouter } from "../src/lib/router.js";

/**
 * NAV-1b — hash/同文档导航的 25s 竞态(2026-06-04 插桩确诊)。
 *
 * 现象:`vortex_navigate` 在 hash/同文档跨路由(`/#/a` → `/#/b`)上**偶发**卡满
 *   ~25s 再 degraded 返回。插桩实测同一 hash 跨路由 load 模式 55ms↔25047ms 抖动,
 *   而 domcontentloaded 模式恒 48-99ms —— 典型竞态。
 *
 * 根因:默认 `waitUntil="load"` 路径的 `waitForTabLoad`(监听 tabs.onUpdated
 *   'complete')在 `chrome.tabs.update` **之后**才挂监听器。hash/同文档导航近乎
 *   瞬时 complete,'complete' 可能在监听器挂上**之前**就 fire 掉被错过 → 干等满
 *   `NAVIGATE_LOAD_TIMEOUT_MS`(25s)再靠 readyState 探测降级。`domcontentloaded`
 *   路径已修(NAV-1:监听器在 update 前挂),默认 load 路径漏修。
 *
 * 修复:load/networkidle 路径同样在 `chrome.tabs.update` 之前创建 `waitForTabLoad`
 *   promise(先挂监听),与 dclPromise 对齐。
 *
 * 该被原"桥降级"(#3)误诊掩盖:竞态偶发,看似"连跑几个 case 后桥降级"。
 */

let updatedListeners: Array<(tabId: number, ci: { status?: string }) => void>;

function installChrome() {
  updatedListeners = [];
  (globalThis as any).chrome = {
    scripting: {
      // 仅超时降级路径会探 readyState;快路径不应触发。
      executeScript: vi.fn().mockResolvedValue([{ result: "complete" }]),
    },
    tabs: {
      onUpdated: {
        addListener: vi.fn((cb: (tabId: number, ci: { status?: string }) => void) => {
          updatedListeners.push(cb);
        }),
        removeListener: vi.fn((cb: any) => {
          updatedListeners = updatedListeners.filter((l) => l !== cb);
        }),
      },
      // hash/同文档导航:complete 在 update 期间**瞬时** fire(向当时已挂的监听器)。
      // 当前代码此刻监听器还没挂(在 update 之后才挂)→ 漏掉;修复后已挂 → 捕获。
      update: vi.fn(async (tabId: number, _info: { url: string }) => {
        for (const l of [...updatedListeners]) l(tabId, { status: "complete" });
        return { id: tabId };
      }),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: "http://localhost:5173/#/el-dropdown",
        title: "el-dropdown",
        status: "complete",
      })),
    },
  };
}

async function importPage() {
  vi.resetModules();
  return import("../src/handlers/page.js");
}

async function flushMicrotasks(): Promise<void> {
  // 多轮 microtask flush,让 update→complete→loadPromise→get 链式 await 跑完。
  // 轮数需覆盖 router 内层 deadline 的 Promise.race 多出的那一跳,仍不推进 timer。
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("navigate hash 同文档导航竞态 (NAV-1b)", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  it("默认 load:complete 在 update 期间瞬时 fire 也不漏 → 快返回(不干等超时)", async () => {
    vi.useFakeTimers();
    installChrome();
    const { registerPageHandlers } = await importPage();
    const router = new ActionRouter();
    registerPageHandlers(router, {} as any);

    let resolved = false;
    const navP = router
      .dispatch({
        type: "tool_request",
        requestId: "1",
        tool: "page.navigate",
        args: { url: "http://localhost:5173/#/el-dropdown" },
        tabId: 100,
      } as any)
      .then((r) => {
        resolved = true;
        return r;
      });

    // 关键:不推进任何 timer。修复前监听器晚挂漏掉瞬时 complete → 仍 pending;
    // 修复后早挂捕获 → microtask 内即 resolve。
    await flushMicrotasks();
    expect(resolved).toBe(true);

    const res = (await navP) as { result?: { degraded?: boolean } };
    // 快路径不应降级。
    expect(res.result?.degraded).toBeUndefined();
    // 快路径不应探 readyState(那是超时降级才做的)。
    expect((globalThis as any).chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe("navigate load 路径接线 (NAV-1b 源码结构)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "page.ts"),
    "utf8",
  );

  it("load 路径的 waitForTabLoad 监听器在 tabs.update 之前挂上(消除 hash 竞态)", () => {
    const idxWait = SRC.indexOf("waitForTabLoad(tid, innerCap)");
    const idxUpdate = SRC.indexOf("chrome.tabs.update(tid, { url })");
    expect(idxWait).toBeGreaterThan(-1);
    expect(idxUpdate).toBeGreaterThan(-1);
    expect(idxWait).toBeLessThan(idxUpdate);
  });
});
