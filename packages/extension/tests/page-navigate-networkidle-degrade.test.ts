import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ActionRouter } from "../src/lib/router.js";

/**
 * navigate waitUntil=networkidle 超时退化须 surface 信号(白盒+DAST,2026-06-20)。
 *
 * 缺陷(silent-degradation + sibling 不对称):
 *   NAVIGATE 的 networkidle 分支在 awaitIdle 超时(网络永不空闲)时,catch 仅
 *   console.warn,**不设任何响应字段** → agent 收到与「真达成 networkidle」完全
 *   无法区分的 {url,title,status},误以为网络已空闲(silent-false-success)。
 *   而同一 handler 的 LOAD 超时退化会设 `degraded:true` —— 同 handler 内一个退化
 *   路径有信号、另一个没有,sibling 不对称。
 *
 *   DAST 实机复现(example.com 注入 8 并发自重排 fetch 循环占满网络):
 *     navigate(url,#hash, waitUntil=networkidle) 等满 ~32s(idleTimeout)后返回
 *     {url,title,status},**无 networkidle 信号**;Date.now() 括住实测 ~33.9s。
 *
 * 修复:networkidle catch 设 networkIdleTimedOut=true,return 透出(与 load-degrade
 *   的 degraded 信号对齐,让 agent 知晓「网络在超时时仍活跃」可选择重试/继续)。
 */

let updatedListeners: Array<(tabId: number, ci: { status?: string }) => void>;
let onEventCb: ((tabId: number, method: string, params: unknown) => void) | undefined;

function installChrome() {
  updatedListeners = [];
  (globalThis as any).chrome = {
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: "complete" }]) },
    tabs: {
      onUpdated: {
        addListener: vi.fn((cb: (tabId: number, ci: { status?: string }) => void) => {
          updatedListeners.push(cb);
        }),
        removeListener: vi.fn(),
      },
      // load 瞬时 complete(向已挂监听器),让 loadPromise 快速 resolve 进入 networkidle 段。
      update: vi.fn(async (tabId: number, _info: { url: string }) => {
        for (const l of [...updatedListeners]) l(tabId, { status: "complete" });
        return { id: tabId };
      }),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: "https://x/#a",
        title: "X",
        status: "complete",
      })),
    },
  };
}

function makeDebuggerMgr() {
  return {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn((cb: (t: number, m: string, p: unknown) => void) => { onEventCb = cb; }),
    offEvent: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    isAttached: vi.fn().mockReturnValue(true),
    sendCommand: vi.fn(),
  } as any;
}

async function importPage() {
  vi.resetModules();
  return import("../src/handlers/page.js");
}

// 多轮 microtask flush,让 update→complete→loadPromise→awaitIdle(enableDomain await)→onEvent 链跑完。
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("navigate waitUntil=networkidle 超时退化须 surface 信号", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
    onEventCb = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  it("networkidle 永不达成 → 响应含 networkIdleTimedOut:true(此前无任何信号 = bug)", async () => {
    vi.useFakeTimers();
    installChrome();
    const dbg = makeDebuggerMgr();
    const { registerPageHandlers } = await importPage();
    const router = new ActionRouter();
    registerPageHandlers(router, dbg);

    const navP = router.dispatch({
      type: "tool_request",
      requestId: "1",
      tool: "page.navigate",
      args: { url: "https://x/#a", waitUntil: "networkidle" },
      tabId: 100,
    } as any);

    // loadPromise 经 update→complete resolve;awaitIdle enableDomain await 后注册 onEvent。
    await flush();
    expect(onEventCb).toBeDefined();
    // fire 一个永不 finish 的请求 → tracked.size=1 永不空闲,idleTimer 被清,只剩 timeout。
    onEventCb!(100, "Network.requestWillBeSent", {
      requestId: "busy-1",
      request: { url: "https://x/busy" },
      type: "Fetch",
    });
    // 推进过 idleTimeout(innerCap=min(30000,25000))→ awaitIdle reject → catch → 信号。
    await vi.advanceTimersByTimeAsync(26_000);

    const res = (await navP) as { result?: { networkIdleTimedOut?: boolean; url?: string } };
    expect(res.result?.networkIdleTimedOut).toBe(true);
    expect(res.result?.url).toBe("https://x/#a");
  });

  it("networkidle 达成(无挂起请求)→ 不设 networkIdleTimedOut(不误报)", async () => {
    vi.useFakeTimers();
    installChrome();
    const dbg = makeDebuggerMgr();
    const { registerPageHandlers } = await importPage();
    const router = new ActionRouter();
    registerPageHandlers(router, dbg);

    const navP = router.dispatch({
      type: "tool_request",
      requestId: "2",
      tool: "page.navigate",
      args: { url: "https://x/#a", waitUntil: "networkidle" },
      tabId: 100,
    } as any);

    await flush();
    // 不 fire 任何请求 → checkIdle 立即起 idleTimer(500ms),推进过它即达成 idle。
    await vi.advanceTimersByTimeAsync(600);

    const res = (await navP) as { result?: { networkIdleTimedOut?: boolean } };
    expect(res.result?.networkIdleTimedOut).toBeUndefined();
  });
});

describe("navigate networkidle 退化信号 source-lock", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "page.ts"),
    "utf8",
  );

  it("networkidle catch 设 networkIdleTimedOut=true(不再仅 console.warn)", () => {
    expect(SRC).toMatch(/networkIdleTimedOut\s*=\s*true/);
  });

  it("return 透出 networkIdleTimedOut 字段", () => {
    expect(SRC).toMatch(/networkIdleTimedOut\s*\?\s*\{\s*networkIdleTimedOut:\s*true\s*\}/);
  });
});
