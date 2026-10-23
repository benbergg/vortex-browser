/**
 * Author: qingwa
 * Description: page.waitForNetworkIdle 的 **静默期(quiet period)** 语义 + pending 端到端诊断。
 *
 * 旧语义：idle 的判定是「tracked（未结束的匹配请求）清空」**且**「最近 idleTime 内无新发起」。
 * 现实里 SPA 的长轮询 / 埋点 beacon / WebSocket 握手会让 tracked 永远非空 ⇒ 永远判不出
 * idle ⇒ navigate 的 networkIdleTimedOut 降级信号也永远不触发（agent 只能干等到传输超时）。
 *
 * 新语义（静默期）：idle 只看**最后一次匹配请求之后是否已过 idleTime**——请求还挂着
 * （pending）不再阻断 idle，但 pending 数必须作为诊断透出，让 agent 知道「这次 idle 是
 * 带着 N 个未结束请求达成的」，而不是「网络真的空了」。
 *
 * 静默期语义的要害：**计时器必须随每个新匹配请求重启**。若只在开始时 arm 一次，
 * 「请求持续不断」的页面永远不会被判 idle（降级信号随之失效）。
 *
 * 本文件锁住 5 条断言：
 *   1. 静默期成立：1 个**未结束**的匹配请求 + idleTime 内无新请求 ⇒ resolve(idle:true)，pendingRequests ≥ 1
 *   2. 持续请求不成立：每 < idleTime 来一个匹配请求、持续到超时 ⇒ reject(TIMEOUT)
 *   3. 诊断在错误文本里：超时时错误 message 文本里能搜到 pending 的 URL 与 type
 *      （MCP 侧错误格式化不序列化 extras，extras 只有程序读得到）
 *   4. 结果带 pending 数：第 1 条的返回里有 pendingRequests 字段且 ≥ 1
 *   5. minRequests 下限仍生效：minRequests 大于实际匹配数时不得 resolve（超时）
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

const TAB = 42;

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

// 排空 enableDomain 的 microtask，让 awaitIdle 注册完 CDP 监听器
async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("page.waitForNetworkIdle 的静默期语义 + pending 诊断", () => {
  let router: ActionRouter;
  let dbg: ReturnType<typeof makeDebuggerMock>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    router = new ActionRouter();
    dbg = makeDebuggerMock();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: TAB }]),
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

  it("断言1 静默期成立：未结束的匹配请求不再阻断 idle，idleTime 内无新请求即 resolve", async () => {
    const p = router.dispatch(
      mkReq("page.waitForNetworkIdle", { idleTime: 200, timeout: 5000 }, TAB),
    );
    await flush();

    // 一个**永远不会结束**的匹配请求（旧语义下 tracked 非空 ⇒ 永远判不出 idle）
    dbg.fire(TAB, "Network.requestWillBeSent", {
      requestId: "pending-1",
      type: "Fetch",
      request: { url: "https://x.test/api/longpoll" },
    });

    // 之后 idleTime 内没有新请求 ⇒ 静默期成立
    await vi.advanceTimersByTimeAsync(250);
    // 再越过 awaitIdle 自身的超时：旧语义下这会 reject(TIMEOUT)，
    // 保证 promise 一定落定（失败信息直指「超时」而不是 vitest 的用例超时）
    await vi.advanceTimersByTimeAsync(5_000);

    const resp = await p;
    expect(resp.error, "静默期语义下不该超时").toBeUndefined();
    expect(resp.result).toMatchObject({ idle: true, matchedRequests: 1 });
  });

  it("断言2 持续请求不成立：每 < idleTime 来一个匹配请求，持续到超时 ⇒ TIMEOUT", async () => {
    const p = router.dispatch(
      mkReq("page.waitForNetworkIdle", { idleTime: 300, timeout: 1000 }, TAB),
    );
    await flush();

    // 每 100ms 一个匹配请求（100 < idleTime 300）——计时器必须随每个新请求重启，
    // 否则静默期永远不成立、请求持续不断也判不出 idle
    for (let i = 0; i < 8; i++) {
      dbg.fire(TAB, "Network.requestWillBeSent", {
        requestId: `tick-${i}`,
        type: "XHR",
        request: { url: `/api/tick/${i}` },
      });
      await vi.advanceTimersByTimeAsync(100);
    }
    // 越过 awaitIdle 自己的超时
    await vi.advanceTimersByTimeAsync(300);

    const resp = await p;
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
  });

  it("断言3 诊断在错误文本里：超时时 message 含 pending 的 URL 与 type", async () => {
    const p = router.dispatch(
      mkReq("page.waitForNetworkIdle", { idleTime: 300, timeout: 600 }, TAB),
    );
    await flush();

    // 一个永不结束的匹配请求（进 pending 明细）
    dbg.fire(TAB, "Network.requestWillBeSent", {
      requestId: "longpoll-1",
      type: "Fetch",
      request: { url: "https://slow.test/api/never-ends" },
    });
    // 持续请求把静默计时器一直顶住 ⇒ 拖到超时
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100);
      dbg.fire(TAB, "Network.requestWillBeSent", {
        requestId: `noise-${i}`,
        type: "XHR",
        request: { url: `/api/noise/${i}` },
      });
    }
    await vi.advanceTimersByTimeAsync(200);

    const resp = await p;
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    // extras 不会被 MCP 侧序列化 ⇒ pending 明细必须拼进 message 文本
    expect(resp.error?.message).toContain("https://slow.test/api/never-ends");
    expect(resp.error?.message).toContain("Fetch");
  });

  it("断言4 结果带 pending 数：resolve 的返回里有 pendingRequests 字段且 ≥ 1", async () => {
    const p = router.dispatch(
      mkReq("page.waitForNetworkIdle", { idleTime: 200, timeout: 5000 }, TAB),
    );
    await flush();

    dbg.fire(TAB, "Network.requestWillBeSent", {
      requestId: "pending-2",
      type: "XHR",
      request: { url: "https://x.test/api/also-pending" },
    });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(5_000); // 同上：旧语义下会超时，保证 promise 落定

    const resp = await p;
    expect(resp.error).toBeUndefined();
    const result = resp.result as { pendingRequests?: number };
    expect(result).toHaveProperty("pendingRequests");
    expect(result.pendingRequests).toBeGreaterThanOrEqual(1);
  });

  it("断言5 minRequests 下限仍生效：minRequests 大于实际匹配数时不得 resolve（超时）", async () => {
    const p = router.dispatch(
      mkReq(
        "page.waitForNetworkIdle",
        { idleTime: 200, timeout: 600, minRequests: 2 },
        TAB,
      ),
    );
    await flush();

    // 只来 1 个匹配请求 < minRequests 2 ⇒ 不允许 idle
    dbg.fire(TAB, "Network.requestWillBeSent", {
      requestId: "only-1",
      type: "Fetch",
      request: { url: "/api/one" },
    });
    await vi.advanceTimersByTimeAsync(700);

    const resp = await p;
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
  });
});
