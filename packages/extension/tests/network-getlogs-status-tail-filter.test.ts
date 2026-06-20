/**
 * network.getLogs 漏实现 debug_read 文档化的 statusMin/statusMax + tail(白盒+DAST,2026-06-20)。
 *
 * 缺陷(silent no-op,文档化输入契约违反):
 *   vortex_debug_read 公开 schema 暴露顶层 `tail` 与 filter `network:{pattern,statusMin/Max}`。
 *   dispatch(dispatch.ts:284-302)把 source=network 路由到 `network.getLogs`,并把
 *   filter Object.assign 进 params、tail 写成 params.limit。但 GET_LOGS handler 只按
 *   pattern 过滤,**不读 statusMin/statusMax/limit** —— statusMin/statusMax 的真实现在
 *   独立的 network.filter action(debug_read 从不走它)。后果:
 *     - filter={pattern,statusMin:400} 求「仅失败请求」却返回 200 一并混入(silent-false 结果);
 *     - tail=N 求「最近 N 条」却返回全部。
 *
 *   DAST 实机复现(example.com 发 200 + 404 两 fetch):
 *     filter={pattern:'vtx',statusMin:400} → 返回 200+404 两条(应仅 404);
 *     tail=1 → 返回 2 条(应 1)。
 *
 * 修复:GET_LOGS 在 pattern 过滤后追加 statusMin/statusMax 范围过滤,sort 后按 limit
 *   取末 N 条(tail 语义=最近 N)。覆盖 debug_read network 唯一 funnel。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";

let registerNetworkHandlers: typeof import("../src/handlers/network.js")["registerNetworkHandlers"];

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId?: number): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", ...(tabId != null ? { tabId } : {}) };
}

function makeDebuggerMock() {
  let onEventCb: ((tabId: number, method: string, params: unknown) => void) | undefined;
  const mgr = {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    isAttached: vi.fn().mockReturnValue(true),
    sendCommand: vi.fn().mockResolvedValue({ body: "", base64Encoded: false }),
    onEvent: vi.fn((cb: (t: number, m: string, p: unknown) => void) => { onEventCb = cb; }),
    offEvent: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
  } as any;
  return { mgr, getOnEventCb: () => onEventCb };
}

function simulateRequest(
  onEventCb: (tabId: number, method: string, params: unknown) => void,
  tabId: number,
  requestId: string,
  url: string,
  status: number,
) {
  onEventCb(tabId, "Network.requestWillBeSent", {
    requestId,
    request: { url, method: "GET", headers: {} },
    type: "Fetch",
  });
  onEventCb(tabId, "Network.responseReceived", {
    requestId,
    response: { status, statusText: "", mimeType: "application/json", headers: {} },
  });
  onEventCb(tabId, "Network.loadingFinished", { requestId });
}

describe("network.getLogs — debug_read statusMin/statusMax + tail(silent no-op 修复)", () => {
  let router: ActionRouter;
  let getOnEventCb: () => ((tabId: number, method: string, params: unknown) => void) | undefined;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router = new ActionRouter();
    const mock = makeDebuggerMock();
    getOnEventCb = mock.getOnEventCb;
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), onRemoved: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
    registerNetworkHandlers(router, mock.mgr, { send: vi.fn() } as any, { emit: vi.fn() } as any);
    await router.dispatch(mkReq("network.subscribe", {}, 42));
  });

  // 灌入 3 条 API 请求:200 / 404 / 500（按序,startTime 递增）
  function seed() {
    const cb = getOnEventCb()!;
    simulateRequest(cb, 42, "r200", "https://x.com/api/ok", 200);
    simulateRequest(cb, 42, "r404", "https://x.com/api/missing", 404);
    simulateRequest(cb, 42, "r500", "https://x.com/api/boom", 500);
  }

  async function getLogs(args: Record<string, unknown>) {
    const resp = await router.dispatch(mkReq("network.getLogs", { pattern: "/api/", ...args }, 42));
    return resp.result as Array<{ url: string; status: number }>;
  }

  it("无 status/tail → 返回全部 3 条(基线不回归)", async () => {
    seed();
    const logs = await getLogs({});
    expect(logs).toHaveLength(3);
  });

  it("statusMin=400 → 仅 404+500(此前返回全部 3 条 = bug)", async () => {
    seed();
    const logs = await getLogs({ statusMin: 400 });
    expect(logs.map((l) => l.status).sort()).toEqual([404, 500]);
  });

  it("statusMax=299 → 仅 200", async () => {
    seed();
    const logs = await getLogs({ statusMax: 299 });
    expect(logs.map((l) => l.status)).toEqual([200]);
  });

  it("statusMin=400 + statusMax=499 → 仅 404", async () => {
    seed();
    const logs = await getLogs({ statusMin: 400, statusMax: 499 });
    expect(logs.map((l) => l.status)).toEqual([404]);
  });

  it("tail=1 → 仅最近 1 条(startTime 最大,此前返回全部 3 条 = bug)", async () => {
    seed();
    const logs = await getLogs({ limit: 1 });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe(500); // 最后 seed 的请求
  });

  it("tail=2 → 最近 2 条(404+500,保持升序)", async () => {
    seed();
    const logs = await getLogs({ limit: 2 });
    expect(logs.map((l) => l.status)).toEqual([404, 500]);
  });

  it("status + tail 组合:statusMin=400 + tail=1 → 先 status 过滤再取末 1 = 500", async () => {
    seed();
    const logs = await getLogs({ statusMin: 400, limit: 1 });
    expect(logs.map((l) => l.status)).toEqual([500]);
  });
});
