import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageRouter } from "../src/message-router.js";
import { VtxErrorCode } from "@vortex-browser/shared";
import type { VtxRequest } from "@vortex-browser/shared";

/**
 * A-4:NM 从未建立连接(手动启 server / NM 配置错)时,WS async 路径不应入 buffer 干等
 * 满 30s,而应立即 fail-fast 为 EXTENSION_NOT_CONNECTED。曾连接过(SW 睡眠/断开)则保留
 * buffer 语义不变(冷启动等首连 / BRIDGE-2)。
 */
function mkStdout() {
  return { write: vi.fn() } as unknown as NodeJS.WritableStream;
}
function mkWs() {
  return { readyState: 1, send: vi.fn() };
}
function mkSessions(ws: ReturnType<typeof mkWs>) {
  return { getClient: () => ws } as any;
}
function req(id: string, action = "page.info"): VtxRequest {
  return { action, id, params: {} };
}

describe("A-4: NM 从未连接 fail-fast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("从未 setNmConnected(true) → routeToExtension 立即返 EXTENSION_NOT_CONNECTED(不 buffer)", () => {
    const ws = mkWs();
    const router = new MessageRouter(mkStdout(), mkSessions(ws));
    router.routeToExtension(req("mcp-1"));
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(sent.id).toBe("mcp-1");
    expect(sent.error.code).toBe(VtxErrorCode.EXTENSION_NOT_CONNECTED);
  });

  it("立即 fail-fast 不挂 30s 定时器(快进 30s 无第二次投递)", () => {
    const ws = mkWs();
    const router = new MessageRouter(mkStdout(), mkSessions(ws));
    router.routeToExtension(req("mcp-1"));
    (ws.send as any).mockClear();
    vi.advanceTimersByTime(31_000);
    expect(ws.send).not.toHaveBeenCalled(); // 无 TIMEOUT 兜底投递,证明走的是 fail-fast 而非 buffer
  });

  it("曾连接过(connect→disconnect)→ 后续请求仍 buffer,不立即 fail-fast", () => {
    const ws = mkWs();
    const router = new MessageRouter(mkStdout(), mkSessions(ws));
    router.setNmConnected(true); // everConnected = true
    router.setNmConnected(false); // 断开,everConnected 仍 true
    (ws.send as any).mockClear();
    router.routeToExtension(req("mcp-2"));
    // everConnected=true → 跳过 fail-fast,入 buffer,故无立即投递
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("NM 在线时 routeToExtension 正常写 stdout,不 fail-fast", () => {
    const ws = mkWs();
    const stdout = mkStdout();
    const router = new MessageRouter(stdout, mkSessions(ws));
    router.setNmConnected(true);
    router.routeToExtension(req("mcp-3"));
    expect(ws.send).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalled();
  });
});
