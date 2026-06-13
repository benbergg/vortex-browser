/**
 * TDD: network.getRequestDetail — 按 requestId 返回单请求 status+body。
 *
 * vortex_debug_read source="request" 经 MCP dispatch 路由到此 action。
 *
 * 覆盖场景:
 *   ① source=request 正常返回 status+body+headers (cached body 路径)
 *   ② reqid 缺失时清晰报错 (error defined)
 *   ③ reqid 找不到对应缓存条目时报错 (error defined)
 *   ④ 大 body 截断 → truncated:true，body 长度 = maxLength
 *   ⑤ network.getLogs 原路径不回归 (smoke)
 *   ⑥ body 不超 maxLength 时 truncated:false
 *
 * 注意:
 * - network.ts 有模块级 state，跨测试必须 vi.resetModules() + 动态 import
 * - subscribedTabs 只在 ensureSubscribed/SUBSCRIBE 后才接收 CDP 事件
 *   → 测试须先 dispatch network.subscribe 让 tab 入订阅集
 * - vi.resetModules() 导致 VtxError 与 router 静态引用的 VtxError 不同类 →
 *   检查 error?.message 而非 error?.code
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";

let registerNetworkHandlers: typeof import("../src/handlers/network.js")["registerNetworkHandlers"];

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

/**
 * 构造 debuggerMock：
 * - onEvent 捕获 network.ts 注册的事件回调
 * - sendCommand 返回 getResponseBody 的 mock 结果
 */
function makeDebuggerMock(
  responseBodyResult: { body: string; base64Encoded: boolean } = {
    body: '{"ok":true}',
    base64Encoded: false,
  },
) {
  let onEventCb: ((tabId: number, method: string, params: unknown) => void) | undefined;
  const sendCommand = vi.fn().mockResolvedValue(responseBodyResult);
  const mgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    isAttached: vi.fn().mockReturnValue(true),
    sendCommand,
    onEvent: vi.fn((cb: (t: number, m: string, p: unknown) => void) => {
      onEventCb = cb;
    }),
    offEvent: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
  } as any;
  return { mgr, sendCommand, getOnEventCb: () => onEventCb };
}

/**
 * 触发 CDP 事件序列让 network.ts 存入一条完整的 NetworkEntry。
 * 调用前必须确保 tab 已订阅（subscribedTabs.has(tabId) = true），
 * 否则 network.ts 事件处理器会静默忽略。
 */
function simulateRequest(
  onEventCb: (tabId: number, method: string, params: unknown) => void,
  tabId: number,
  requestId: string,
  url: string,
  status: number,
  responseHeaders: Record<string, string> = { "content-type": "application/json" },
) {
  // requestWillBeSent — 入 pendingRequests
  onEventCb(tabId, "Network.requestWillBeSent", {
    requestId,
    request: { url, method: "POST", headers: {} },
    type: "Fetch",
  });
  // responseReceived — 从 pending 移入 apiLogs（携带 status/headers）
  onEventCb(tabId, "Network.responseReceived", {
    requestId,
    response: {
      status,
      statusText: status >= 200 && status < 300 ? "OK" : "Error",
      mimeType: "application/json",
      headers: responseHeaders,
    },
  });
  // loadingFinished — 触发异步 getResponseBody 写入 responseBodies 缓存
  onEventCb(tabId, "Network.loadingFinished", { requestId });
}

describe("network.getRequestDetail (source=request) — 单请求 status+body", () => {
  let router: ActionRouter;
  let getOnEventCb: () => ((tabId: number, method: string, params: unknown) => void) | undefined;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router = new ActionRouter();

    const mock = makeDebuggerMock({ body: '{"ok":true}', base64Encoded: false });
    getOnEventCb = mock.getOnEventCb;

    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        onRemoved: { addListener: vi.fn() },
      },
      scripting: {
        // readResourceTimingEntries 需要 executeScript
        executeScript: vi.fn().mockResolvedValue([{ result: [] }]),
      },
    });

    ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
    registerNetworkHandlers(
      router,
      mock.mgr,
      { send: vi.fn() } as any,
      { emit: vi.fn() } as any,
    );

    // 订阅 tab 42，使 subscribedTabs.has(42) = true
    // （network.ts 事件回调入口检查此条件；未订阅则静默忽略所有 CDP 事件）
    await router.dispatch(mkReq("network.subscribe", {}, 42));
  });

  it("① 正常返回 status+statusText+headers+body (cached body 路径)", async () => {
    const onEventCb = getOnEventCb()!;
    simulateRequest(onEventCb, 42, "req-001", "https://x.com/api/submit", 200);

    // 等待异步 loadingFinished → getResponseBody promise 落地
    await new Promise((r) => setTimeout(r, 10));

    const resp = await router.dispatch(
      mkReq("network.getRequestDetail", { requestId: "req-001" }, 42),
    );
    expect(resp.error).toBeUndefined();
    const detail = resp.result as Record<string, unknown>;
    expect(detail.status).toBe(200);
    expect(detail.statusText).toBe("OK");
    expect(detail.headers).toEqual({ "content-type": "application/json" });
    expect(detail.body).toBe('{"ok":true}');
    expect(detail.truncated).toBe(false);
  });

  it("② reqid 缺失时报错(error.message 含 reqid/requestId)", async () => {
    const resp = await router.dispatch(
      mkReq("network.getRequestDetail", {}, 42),
    );
    expect(resp.error).toBeDefined();
    // vi.resetModules 导致 VtxError instanceof 失败 → code 退化为 JS_EXECUTION_ERROR
    // 检查 message 而非 code
    expect(resp.error?.message).toMatch(/requestId.*required|reqid.*required/i);
  });

  it("③ reqid 找不到对应缓存条目时报错(error.message 含 not found)", async () => {
    const resp = await router.dispatch(
      mkReq("network.getRequestDetail", { requestId: "nonexistent-id" }, 42),
    );
    expect(resp.error).toBeDefined();
    expect(resp.error?.message).toMatch(/not found|nonexistent/i);
  });

  it("④ body 超过 maxLength(默认 10240)时截断并 truncated:true", async () => {
    // 需要独立模块实例（不同 sendCommand mock 返回大 body）
    vi.resetModules();
    const router2 = new ActionRouter();
    const bigBody = "x".repeat(20000);
    const mock2 = makeDebuggerMock({ body: bigBody, base64Encoded: false });
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        onRemoved: { addListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
    registerNetworkHandlers(
      router2,
      mock2.mgr,
      { send: vi.fn() } as any,
      { emit: vi.fn() } as any,
    );

    // 订阅 tab 42
    await router2.dispatch(mkReq("network.subscribe", {}, 42));

    const onEventCb2 = mock2.getOnEventCb()!;
    simulateRequest(onEventCb2, 42, "req-big", "https://x.com/api/big", 200);
    await new Promise((r) => setTimeout(r, 10));

    const resp = await router2.dispatch(
      mkReq("network.getRequestDetail", { requestId: "req-big" }, 42),
    );
    expect(resp.error).toBeUndefined();
    const detail = resp.result as Record<string, unknown>;
    expect(typeof detail.body).toBe("string");
    expect((detail.body as string).length).toBe(10240);
    expect(detail.truncated).toBe(true);
  });

  it("⑤ network.getLogs 原路径不受影响 — smoke", async () => {
    const resp = await router.dispatch(
      mkReq("network.getLogs", { pattern: "/api/" }, 42),
    );
    // 无错误，返回空数组（无 CDP 事件触发）
    expect(resp.error).toBeUndefined();
    expect(Array.isArray(resp.result)).toBe(true);
  });

  it("⑥ body 不超 maxLength 时 truncated:false", async () => {
    const onEventCb = getOnEventCb()!;
    simulateRequest(onEventCb, 42, "req-short", "https://x.com/api/short", 201);
    await new Promise((r) => setTimeout(r, 10));

    const resp = await router.dispatch(
      mkReq("network.getRequestDetail", { requestId: "req-short" }, 42),
    );
    expect(resp.error).toBeUndefined();
    const detail = resp.result as Record<string, unknown>;
    expect(detail.truncated).toBe(false);
    expect(detail.status).toBe(201);
  });
});
