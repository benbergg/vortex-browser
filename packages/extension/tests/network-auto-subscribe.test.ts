import { describe, it, expect, vi, beforeEach } from "vitest";
import { splitDiagnosis, type NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
// network.ts 有模块级 state（subscribedTabs/tabConfigs），跨测试要用 vi.resetModules 后动态 import
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

function makeDebuggerMock() {
  const enableDomain = vi.fn().mockResolvedValue(undefined);
  return {
    mgr: {
      enableDomain,
      isAttached: vi.fn().mockReturnValue(false),
      sendCommand: vi.fn(),
      onEvent: vi.fn(),
      offEvent: vi.fn(),
      attach: vi.fn().mockResolvedValue(undefined),
    } as any,
    enableDomain,
  };
}

function makeNmMock() {
  return { send: vi.fn() } as any;
}

function makeDispatcherMock() {
  return { emit: vi.fn() } as any;
}

describe("network auto-subscribe (@since 0.4.0)", () => {
  let router: ActionRouter;
  let enableDomain: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router = new ActionRouter();
    const dbg = makeDebuggerMock();
    enableDomain = dbg.enableDomain;

    const onRemovedListeners: Array<(tabId: number) => void> = [];
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        onRemoved: {
          addListener: (fn: any) => onRemovedListeners.push(fn),
        },
      },
    });

    ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
    registerNetworkHandlers(router, dbg.mgr, makeNmMock(), makeDispatcherMock());
  });

  it("GET_LOGS first call enables Network domain on the tab", async () => {
    const resp = await router.dispatch(mkReq("network.getLogs", {}, 42));
    expect(resp.error).toBeUndefined();
    // 空结果带自陈信封(说明捕获才刚开始),载荷本身仍是 []
    expect(splitDiagnosis(resp.result).value).toEqual([]); // no requests yet
    expect(enableDomain).toHaveBeenCalledTimes(1);
    expect(enableDomain).toHaveBeenCalledWith(42, "Network");
  });

  it("GET_LOGS second call is idempotent (no extra enableDomain)", async () => {
    await router.dispatch(mkReq("network.getLogs", {}, 42));
    await router.dispatch(mkReq("network.getLogs", {}, 42));
    expect(enableDomain).toHaveBeenCalledTimes(1);
  });

  it("GET_ERRORS also auto-subscribes", async () => {
    await router.dispatch(mkReq("network.getErrors", {}, 43));
    expect(enableDomain).toHaveBeenCalledWith(43, "Network");
  });

  it("FILTER also auto-subscribes", async () => {
    await router.dispatch(mkReq("network.filter", {}, 44));
    expect(enableDomain).toHaveBeenCalledWith(44, "Network");
  });

  it("explicit SUBSCRIBE after auto-subscribe updates config without re-enabling domain twice per tab", async () => {
    await router.dispatch(mkReq("network.getLogs", {}, 42));
    await router.dispatch(
      mkReq(
        "network.subscribe",
        { urlPattern: "/api/query", maxApiLogs: 100 },
        42,
      ),
    );
    // SUBSCRIBE 会再调 enableDomain（显式订阅仍应激活一次以保证 idempotent），
    // 但两次都是针对同一 tab 同一 domain，由 debugger-manager 内部去重。
    expect(enableDomain).toHaveBeenCalledTimes(2);
    expect(enableDomain.mock.calls.every((c) => c[0] === 42 && c[1] === "Network")).toBe(true);
  });

  it("different tabs auto-subscribe independently", async () => {
    await router.dispatch(mkReq("network.getLogs", {}, 42));
    await router.dispatch(mkReq("network.getLogs", {}, 99));
    expect(enableDomain).toHaveBeenCalledTimes(2);
    const tabIds = enableDomain.mock.calls.map((c) => c[0]);
    expect(new Set(tabIds)).toEqual(new Set([42, 99]));
  });
});
