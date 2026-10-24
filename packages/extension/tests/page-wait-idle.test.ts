/**
 * page.waitForXhrIdle / page.waitForNetworkIdle 的 idle 判定语义。
 *
 * ★ **静默期语义**（2026-10-23 起，见 packages/extension/src/handlers/page.ts 的 awaitIdle）：
 *   idle 只看「最后一次**匹配**请求后是否已过 idleTime」——
 *   - 未结束的请求（pending）**不再阻断 idle**，只作为诊断从 `pendingRequests` 透出；
 *   - 静默计时器**随每个新匹配请求重启**；结束事件只更新诊断集合，不碰计时器。
 *
 * 本文件里三条用例原先锁的是旧语义（"在飞必须结束才能 idle"），已按新语义重写；
 * 超时路径改由「请求持续不断到来（间隔 < idleTime）」触发 —— 这是有意的语义变更，不是回归。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";

type CdpEventCallback = (
  tabId: number,
  method: string,
  params: unknown,
) => void;

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

function makeDebuggerMock() {
  const callbacks: CdpEventCallback[] = [];
  const enableDomain = vi.fn().mockResolvedValue(undefined);
  const onEvent = vi.fn((cb: CdpEventCallback) => {
    callbacks.push(cb);
  });
  const offEvent = vi.fn((cb: CdpEventCallback) => {
    const i = callbacks.indexOf(cb);
    if (i >= 0) callbacks.splice(i, 1);
  });
  return {
    mgr: {
      enableDomain,
      onEvent,
      offEvent,
      sendCommand: vi.fn(),
      attach: vi.fn().mockResolvedValue(undefined),
      isAttached: vi.fn().mockReturnValue(true),
    } as any,
    fire(tabId: number, method: string, params: unknown) {
      for (const cb of [...callbacks]) cb(tabId, method, params);
    },
    callbacks,
  };
}

describe("page.waitForXhrIdle / waitForNetworkIdle (@since 0.4.0)", () => {
  let router: ActionRouter;
  let dbg: ReturnType<typeof makeDebuggerMock>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    router = new ActionRouter();
    dbg = makeDebuggerMock();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        get: vi.fn(),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        reload: vi.fn(),
      },
    });
    registerPageHandlers(router, dbg.mgr);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waitForXhrIdle resolves when no XHR pending (idleTime elapses)", async () => {
    const p = router.dispatch(
      mkReq("page.waitForXhrIdle", { idleTime: 200, timeout: 5000 }, 42),
    );
    // 触发 debuggerMgr.enableDomain 的 microtask 排空：
    await Promise.resolve();
    await Promise.resolve();
    // 没有请求事件发出 —— 期望 idleTime 后 resolve
    await vi.advanceTimersByTimeAsync(250);
    const resp = await p;
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ idle: true, matchedRequests: 0 });
  });

  it("waitForXhrIdle ignores WebSocket / Image / Stylesheet", async () => {
    const p = router.dispatch(
      mkReq("page.waitForXhrIdle", { idleTime: 200, timeout: 5000 }, 42),
    );
    await Promise.resolve();
    await Promise.resolve();
    // 一堆非 XHR 请求；idleTime 到期前不应被视为"匹配"请求，idle 照常触发
    dbg.fire(42, "Network.requestWillBeSent", {
      requestId: "ws-1",
      type: "WebSocket",
      request: { url: "wss://telemetry/" },
    });
    dbg.fire(42, "Network.requestWillBeSent", {
      requestId: "img-1",
      type: "Image",
      request: { url: "https://cdn/avatar.png" },
    });
    await vi.advanceTimersByTimeAsync(250);
    const resp = await p;
    expect(resp.result).toMatchObject({ idle: true, matchedRequests: 0 });
  });

  it("waitForXhrIdle: XHR 仍在飞时，静默期满即 resolve（pending 可见）", async () => {
    const p = router.dispatch(
      mkReq("page.waitForXhrIdle", { idleTime: 200, timeout: 5000 }, 42),
    );
    await Promise.resolve();
    await Promise.resolve();
    // XHR 开始；此后**不再** fire loadingFinished ⇒ 它始终在飞
    dbg.fire(42, "Network.requestWillBeSent", {
      requestId: "xhr-1",
      type: "XHR",
      request: { url: "/api/query" },
    });
    let resp: { result?: unknown; error?: { code?: string } } | null = null;
    void p.then((r) => {
      resp = r;
    });
    // ★ 静默期语义：静默计时器由「最后一次匹配请求」起算，**不等 XHR 结束**。
    //   旧语义下 pending 会阻断 idle ⇒ 这里会一直挂到 timeout 才结束（下面第 2 条）。
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(resp, "静默期满 ⇒ 应 resolve（旧语义下 pending 阻断，会一直挂住）").not.toBeNull();
    expect(resp!.error).toBeUndefined();
    // matchedRequests=1 ⇒ XHR 被计入；pendingRequests=1 ⇒ resolve 那一刻它**仍在飞**，
    // 诊断如实透出（agent 不会把「带着 1 个在飞请求的静默期」误读成「网络真的空了」）
    expect(resp!.result).toMatchObject({
      idle: true,
      matchedRequests: 1,
      pendingRequests: 1,
    });
    // resolve 后已 cleanup ⇒ CDP 监听器被摘（不再监听网络事件）
    expect(dbg.callbacks.length).toBe(0);
  });

  it("waitForNetworkIdle with urlPattern only counts matching requests", async () => {
    const p = router.dispatch(
      mkReq(
        "page.waitForNetworkIdle",
        { idleTime: 200, timeout: 5000, urlPattern: "/api/query" },
        42,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    // 非匹配 URL 不影响 idle
    dbg.fire(42, "Network.requestWillBeSent", {
      requestId: "other-1",
      type: "XHR",
      request: { url: "/api/other" },
    });
    await vi.advanceTimersByTimeAsync(250);
    const resp = await p;
    expect(resp.result).toMatchObject({ idle: true, matchedRequests: 0 });
  });

  it("waitForXhrIdle with minRequests=1 refuses to idle before a matching request has started", async () => {
    const p = router.dispatch(
      mkReq(
        "page.waitForXhrIdle",
        { idleTime: 200, timeout: 3000, minRequests: 1 },
        42,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    // idleTime 到也不应 resolve，因为 minRequests=1 没满足
    await vi.advanceTimersByTimeAsync(500);
    expect(dbg.callbacks.length).toBe(1);
    // 发起并完成 1 个 XHR，minRequests 满足后应 resolve
    dbg.fire(42, "Network.requestWillBeSent", {
      requestId: "xhr-9",
      type: "XHR",
      request: { url: "/any" },
    });
    dbg.fire(42, "Network.loadingFinished", { requestId: "xhr-9" });
    await vi.advanceTimersByTimeAsync(250);
    const resp = await p;
    expect(resp.result).toMatchObject({ idle: true, matchedRequests: 1 });
  });

  it("waitForXhrIdle: 挂着的匹配 XHR 不再导致超时（静默期语义）", async () => {
    const p = router.dispatch(
      mkReq("page.waitForXhrIdle", { idleTime: 200, timeout: 500 }, 42),
    );
    await Promise.resolve();
    await Promise.resolve();
    dbg.fire(42, "Network.requestWillBeSent", {
      requestId: "long",
      type: "Fetch",
      request: { url: "/slow" },
    });
    let resp: { result?: unknown; error?: { code?: string } } | null = null;
    void p.then((r) => {
      resp = r;
    });
    // ★ 静默期语义：挂着的请求**不再**阻断 idle ⇒ 200ms 静默期满即 resolve，**不会**超时。
    //   旧语义下 pending 阻断 ⇒ 500ms 后必然 TIMEOUT（这正是本用例的旧断言）。
    await vi.advanceTimersByTimeAsync(600);
    await Promise.resolve();
    expect(resp, "静默期满 ⇒ 应 resolve，而不是超时").not.toBeNull();
    expect(resp!.error, "挂着的 XHR 不再导致超时").toBeUndefined();
    expect(resp!.result).toMatchObject({
      idle: true,
      matchedRequests: 1,
      pendingRequests: 1,
    });
  });

  it("waitForXhrIdle TIMEOUTs when matching requests keep arriving（静默期永不达成）", async () => {
    const p = router.dispatch(
      mkReq("page.waitForXhrIdle", { idleTime: 200, timeout: 500 }, 42),
    );
    await Promise.resolve();
    await Promise.resolve();
    // ★ 超时路径在新语义下**仍然可达**，但触发条件变了：
    //   只有「匹配请求持续不断到来（间隔 < idleTime）」才能让静默期永远无法达成。
    //   （挂着的单个请求不再能触发超时 —— 见上一条。）
    const STEP = 100; // < idleTime(200ms)：请求间隔短于静默期 ⇒ 持续打断
    for (let i = 0; i < 5; i++) {
      dbg.fire(42, "Network.requestWillBeSent", {
        requestId: `xhr-${i}`,
        type: "XHR",
        request: { url: "/api/query" },
      });
      await vi.advanceTimersByTimeAsync(STEP);
    }
    // 再推进一格，确保 timeout(500ms) 触发（请求在 t=0/100/200/300/400 各来一个）
    await vi.advanceTimersByTimeAsync(STEP);

    const resp = await p;
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    // 超时诊断来自**静默期**记账：5 个请求全部到达且全部还在飞（没有一个结束），
    // 且最后一次匹配请求刚到（< idleTime）⇒ 是「持续打断」而非「一个请求挂着」导致的超时。
    // （旧实现没有 lastMatchedAgoMs 这个概念 ⇒ 语义改回旧版时本断言会红）
    const extras = (resp.error as { context?: { extras?: Record<string, unknown> } })?.context?.extras;
    expect(extras?.matched).toBe(5);
    expect(extras?.pending).toBe(5);
    expect(typeof extras?.lastMatchedAgoMs).toBe("number");
    expect(extras!.lastMatchedAgoMs as number).toBeLessThan(200);
  });

  it("loadingFinished for a filtered-out request does not drive pending below zero", async () => {
    const p = router.dispatch(
      mkReq("page.waitForXhrIdle", { idleTime: 200, timeout: 5000 }, 42),
    );
    await Promise.resolve();
    await Promise.resolve();
    // 只 fire loadingFinished（跳过 requestWillBeSent 过滤）—— 最早的实现会 pending--
    // 变成 -1 造成假 idle；现实现要求 requestId 在 tracked 里
    dbg.fire(42, "Network.loadingFinished", { requestId: "ghost" });
    // 紧接着真的发起一个 XHR 并挂起，不能因为 ghost 让计数出错
    dbg.fire(42, "Network.requestWillBeSent", {
      requestId: "real",
      type: "XHR",
      request: { url: "/ok" },
    });
    let resp: { result?: unknown; error?: { code?: string } } | null = null;
    void p.then((r) => {
      resp = r;
    });
    // 静默期满 ⇒ resolve（静默期语义：pending 不阻断 idle）
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect(resp, "静默期满 ⇒ 应 resolve").not.toBeNull();
    expect(resp!.error).toBeUndefined();
    // ghost（从未发起过的请求）既没被计入 matched，也没把 pending 减成 0 / 负数：
    //   matchedRequests=1（只有 real）  pendingRequests=1（只有 real 在飞）
    // pending 若被 ghost 减成 0，这里会是 0（假空）；若被减成负数，更是错的。
    expect(resp!.result).toMatchObject({
      idle: true,
      matchedRequests: 1,
      pendingRequests: 1,
    });
    // 没有「假 idle」：ghost 没让等待提前结束 —— 静默期(200ms) 走满才 resolve
    expect((resp!.result as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(200);
  });
});
