import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";

/**
 * BUG-003 (N0063): vortex_debug_read(source=network) → network.getLogs。CDP Network 仅捕获
 * enable 之后的请求,首次 debug_read 之前已发生的请求全丢(实测 bytenew CDP 0 vs Resource
 * Timing 250)。getLogs 须回填 page-side `performance.getEntriesByType('resource')` 历史
 * (url/initiator/duration,无 method/status),按 pattern 过滤,默认只留 API 类滤静态噪声。
 */
let registerNetworkHandlers: typeof import("../src/handlers/network.js")["registerNetworkHandlers"];

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId?: number): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", ...(tabId != null ? { tabId } : {}) } as NmRequest;
}

const RT_ENTRIES = [
  { url: "https://x.com/api/orders", initiatorType: "fetch", startTime: 1000, duration: 12 },
  { url: "https://x.com/api/user", initiatorType: "xmlhttprequest", startTime: 1001, duration: 8 },
  { url: "https://x.com/static/app.js", initiatorType: "script", startTime: 1002, duration: 30 },
];

describe("network getLogs Resource Timing 回填 (BUG-003 N0063)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let onEventCb: ((tabId: number, method: string, params: unknown) => void) | undefined;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router = new ActionRouter();
    executeScript = vi.fn().mockResolvedValue([{ result: RT_ENTRIES }]);
    onEventCb = undefined;
    const dbg = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      isAttached: vi.fn().mockReturnValue(false),
      sendCommand: vi.fn().mockResolvedValue({ body: "", base64Encoded: false }),
      onEvent: vi.fn((cb: (t: number, m: string, p: unknown) => void) => { onEventCb = cb; }),
      offEvent: vi.fn(),
      attach: vi.fn().mockResolvedValue(undefined),
    } as never;
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), onRemoved: { addListener: vi.fn() } },
      scripting: { executeScript },
    });
    ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
    registerNetworkHandlers(router, dbg, { send: vi.fn() } as never, { emit: vi.fn() } as never);
  });

  it("无 CDP 历史时,getLogs 回填 Resource Timing 的 API 类请求(pattern 过滤)", async () => {
    const resp = await router.dispatch(mkReq("network.getLogs", { pattern: "/api/" }, 42));
    expect(resp.error).toBeUndefined();
    const logs = resp.result as Array<{ url: string }>;
    const urls = logs.map((l) => l.url);
    expect(urls).toContain("https://x.com/api/orders");
    expect(urls).toContain("https://x.com/api/user");
    // 静态 script 非 API 类,默认(无 includeResources)滤掉
    expect(urls).not.toContain("https://x.com/static/app.js");
  });

  it("pattern 不匹配的条目被滤掉", async () => {
    const resp = await router.dispatch(mkReq("network.getLogs", { pattern: "orders" }, 42));
    const urls = (resp.result as Array<{ url: string }>).map((l) => l.url);
    expect(urls).toEqual(["https://x.com/api/orders"]);
  });

  it("includeResources=true 时静态资源也回填", async () => {
    const resp = await router.dispatch(mkReq("network.getLogs", { pattern: "x.com", includeResources: true }, 42));
    const urls = (resp.result as Array<{ url: string }>).map((l) => l.url);
    expect(urls).toContain("https://x.com/static/app.js");
  });

  it("includeResources=true 时 CDP 静态资源与 RT 同 URL 去重(CDP 优先,不双现)", async () => {
    // 先订阅(getLogs 触发 ensureSubscribed),再经 onEvent 注入一个 CDP Script 请求 →
    // 进 resourceLogs;RT 也含同 URL app.js → 应只出现一次(CDP 条目带 status,优先)。
    await router.dispatch(mkReq("network.getLogs", { pattern: "x.com" }, 42));
    const sameUrl = "https://x.com/static/app.js";
    onEventCb!(42, "Network.requestWillBeSent", {
      requestId: "rq1",
      request: { url: sameUrl, method: "GET", headers: {} },
      type: "Script",
    });
    onEventCb!(42, "Network.responseReceived", {
      requestId: "rq1",
      response: { status: 200, statusText: "OK", mimeType: "application/javascript", headers: {} },
    });
    const resp = await router.dispatch(
      mkReq("network.getLogs", { pattern: "app.js", includeResources: true }, 42),
    );
    const logs = resp.result as Array<{ url: string; status?: number }>;
    const appJs = logs.filter((l) => l.url === sameUrl);
    expect(appJs).toHaveLength(1);
    expect(appJs[0].status).toBe(200); // CDP 条目(有 status)胜出,非 RT 摘要
  });
});
