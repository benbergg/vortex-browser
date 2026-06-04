import { describe, it, expect, vi } from "vitest";
import { MessageRouter } from "../src/message-router.js";
import { VtxErrorCode } from "@bytenew/vortex-shared";
import type { VtxRequest } from "@bytenew/vortex-shared";

/**
 * 白盒审计批次 5 族 P — 桥接生命周期。
 *
 * BRIDGE-2:扩展 SW 死亡 → NM stdin 'end' → setNmConnected(false)。原实现不 reject
 *   in-flight pending,进程因 WS 仍 listening 不退,请求干等 30s 才 TIMEOUT。stdin 'end'
 *   是终态(本进程不再有 data,重启 SW spawn 新 host),pending 永远等不到响应 →
 *   立即 fail-fast 为 EXTENSION_NOT_CONNECTED。
 * BRIDGE-3a:WS client 被驱逐/断开时,旧会话发起的 async in-flight 请求若不清,其响应
 *   会投给继任者(继任者 id 不匹配虽会丢,但 pending 泄漏)。client 切换清 async pending;
 *   HTTP sync 请求与 WS 会话无关,不动。
 */

function mkStdout() {
  return { write: vi.fn() } as unknown as NodeJS.WritableStream;
}
function mkWs() {
  return { readyState: 1, send: vi.fn() };
}
function mkSessions(ws: ReturnType<typeof mkWs> | null) {
  return { getClient: () => ws } as any;
}
function req(id: string, action = "page.info"): VtxRequest {
  return { action, id, params: {} };
}

describe("BRIDGE-2: NM 断开 fail-fast pending", () => {
  it("async pending → 立即收到 EXTENSION_NOT_CONNECTED(不等 30s)", () => {
    const ws = mkWs();
    const router = new MessageRouter(mkStdout(), mkSessions(ws));
    router.setNmConnected(true);
    router.routeToExtension(req("mcp-1"));
    router.setNmConnected(false);
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sent.id).toBe("mcp-1");
    expect(sent.error.code).toBe(VtxErrorCode.EXTENSION_NOT_CONNECTED);
  });

  it("HTTP sync pending → resolve 为 EXTENSION_NOT_CONNECTED", async () => {
    const router = new MessageRouter(mkStdout(), mkSessions(mkWs()));
    router.setNmConnected(true);
    const p = router.routeToExtensionSync(req("cli-1"));
    router.setNmConnected(false);
    const resp = await p;
    expect(resp.error?.code).toBe(VtxErrorCode.EXTENSION_NOT_CONNECTED);
  });

  it("断开后 pending 已清:迟到的 extension 响应不再投递", () => {
    const ws = mkWs();
    const router = new MessageRouter(mkStdout(), mkSessions(ws));
    router.setNmConnected(true);
    router.routeToExtension(req("mcp-1")); // 内部 requestId = r-1
    router.setNmConnected(false);
    (ws.send as any).mockClear();
    router.handleNmMessage({ type: "tool_response", requestId: "r-1", result: {} } as any);
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("BRIDGE-3a: WS client 切换清 async pending", () => {
  it("client 切换 → async pending 清除,不投给继任者", () => {
    const ws = mkWs();
    const router = new MessageRouter(mkStdout(), mkSessions(ws));
    router.setNmConnected(true);
    router.routeToExtension(req("mcp-A-1")); // requestId = r-1
    router.failPendingAsyncOnClientChange();
    expect(ws.send).not.toHaveBeenCalled();
    // 迟到响应:pending 已清 → 不投递
    router.handleNmMessage({ type: "tool_response", requestId: "r-1", result: {} } as any);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("client 切换不影响 HTTP sync pending(与 WS 会话无关)", async () => {
    const router = new MessageRouter(mkStdout(), mkSessions(mkWs()));
    router.setNmConnected(true);
    const p = router.routeToExtensionSync(req("cli-1")); // requestId = r-1
    router.failPendingAsyncOnClientChange();
    router.handleNmMessage({ type: "tool_response", requestId: "r-1", result: { ok: true } } as any);
    const resp = await p;
    expect(resp.result).toEqual({ ok: true });
  });
});
