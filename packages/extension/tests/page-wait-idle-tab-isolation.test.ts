/**
 * Author: qingwa
 * Description: page.waitForNetworkIdle 的 **tab 事件隔离**（最终整体评审 Important 5）。
 *
 * 扩展的 awaitIdle 只应跟踪**本 tab** 的 CDP 网络事件
 * （packages/extension/src/handlers/page.ts 的 `if (evtTabId !== tid) return;`）。
 * 本文件把这一行锁住：删掉它 ⇒ 用例变红（后台 tab 的请求会被算成前台的匹配请求，
 * matchedRequests 从 0 变 1）。
 *
 * ★ **静默期语义**（2026-10-23 起）：idle 判定只看「最后一次匹配请求后是否已过
 * idleTime」，**未结束的请求（pending）不再阻断 idle**，只作为诊断从 pendingRequests 透出。
 * 因此「前台自己的请求仍在飞」在新语义下**会**判 idle——这与旧语义相反，
 * 是有意的语义变更，不是回归。
 *
 * 配套的 bench 侧回归测试在
 * packages/vortex-bench/tests/event-isolation-case.test.ts（那边模拟扩展语义驱动真用例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";

type CdpEventCallback = (
  tabId: number,
  method: string,
  params: unknown,
) => void;

const FG_TAB = 42;
const BG_TAB = 77;

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

describe("page.waitForNetworkIdle 的 tab 事件隔离", () => {
  let router: ActionRouter;
  let dbg: ReturnType<typeof makeDebuggerMock>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    router = new ActionRouter();
    dbg = makeDebuggerMock();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: FG_TAB }]),
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

  it("后台 tab 的慢请求不影响前台 idle 判定", async () => {
    const p = router.dispatch(
      mkReq("page.waitForNetworkIdle", { idleTime: 200, timeout: 5000 }, FG_TAB),
    );
    // 排空 enableDomain 的 microtask，让监听器注册完
    await Promise.resolve();
    await Promise.resolve();

    // 后台 tab 发起一个慢请求（属于别的 tab）
    dbg.fire(BG_TAB, "Network.requestWillBeSent", {
      requestId: "bg-1",
      type: "Fetch",
      request: { url: "/slow?ms=6000" },
    });

    let resp: { result?: unknown; error?: { code?: string } } | null = null;
    void p.then((r) => {
      resp = r;
    });
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    // ★ 静默期语义（2026-10-24 评审 F5 更正）：**单个后台 pending 不再阻断 idle**
    //   （pending 不参与 idle 判定）。即便删掉 tab 事件过滤，后台请求也只会把
    //   matched 从 0 抬到 1、把静默期重置**一次**，前台照样会判出 idle ——
    //   真正的判别点在下面的 matchedRequests: 0（而不是「不再 idle」）。
    expect(resp, "后台 tab 的慢请求不应拖住前台的 idle 判定").not.toBeNull();
    expect(resp!.error).toBeUndefined();
    expect(resp!.result).toMatchObject({ idle: true, matchedRequests: 0 });
  });

  it("前台 tab 自己的请求仍在飞：静默期到期判 idle，且 pendingRequests 可见", async () => {
    const p = router.dispatch(
      mkReq("page.waitForNetworkIdle", { idleTime: 200, timeout: 5000 }, FG_TAB),
    );
    await Promise.resolve();
    await Promise.resolve();

    dbg.fire(FG_TAB, "Network.requestWillBeSent", {
      requestId: "fg-1",
      type: "Fetch",
      request: { url: "/api/query" },
    });

    let resp: { result?: unknown; error?: { code?: string } } | null = null;
    void p.then((r) => {
      resp = r;
    });
    // ★ 静默期语义：请求还在飞（没有 loadingFinished），但已连续 idleTime(200ms)
    //   没有新的匹配请求 ⇒ 判 idle。旧语义下这里是 toBeNull()（pending 阻断 idle），
    //   新语义下 pending 不再阻断，只作为诊断透出。
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect(resp, "静默期已满 → 应判 idle（pending 请求不再阻断 idle 判定）").not.toBeNull();
    expect(resp!.error).toBeUndefined();
    // matchedRequests=1 ⇒ 前台自己的请求确实被计入（过滤只挡别的 tab，不是关掉跟踪）
    // pendingRequests=1 ⇒ 该请求在 resolve 那一刻**仍未结束**，诊断如实透出
    expect(resp!.result).toMatchObject({
      idle: true,
      matchedRequests: 1,
      pendingRequests: 1,
    });
  });
});
