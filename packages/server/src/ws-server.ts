import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";
import type { VtxRequest } from "@bytenew/vortex-shared";
import { VtxErrorCode } from "@bytenew/vortex-shared";
import type { SessionManager } from "./session.js";
import type { MessageRouter } from "./message-router.js";

export function createWsServer(
  httpServer: Server,
  sessions: SessionManager,
  router: MessageRouter,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    // 驱逐场景:新连接会顶掉旧 client。旧 client 发起的 async in-flight 请求须清掉,
    // 其响应不应投给继任者(BRIDGE-3a)。register 内部完成驱逐,故 register 后调用。
    const evicted = sessions.hasClient();
    const clientId = sessions.register(ws);
    if (evicted) router.failPendingAsyncOnClientChange();
    console.error(`[ws] client connected: ${clientId}`);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as VtxRequest;
        if (!msg.action || !msg.id) {
          ws.send(JSON.stringify({
            action: msg.action ?? "unknown",
            id: msg.id ?? "unknown",
            error: { code: VtxErrorCode.INVALID_PARAMS, message: "Missing required fields: action, id" },
          }));
          return;
        }
        router.routeToExtension(msg);
      } catch {
        ws.send(JSON.stringify({
          action: "unknown", id: "unknown",
          error: { code: VtxErrorCode.INVALID_PARAMS, message: "Invalid JSON message" },
        }));
      }
    });

    ws.on("close", () => {
      // 仅当关闭的是当前活跃 client 才清 async pending:被驱逐的旧 ws 稍后 close 时
      // 当前 client 已是继任者,不能误清继任者的 pending(BRIDGE-3a)。
      const wasActive = sessions.getClient() === ws;
      sessions.unregister(ws);
      if (wasActive) router.failPendingAsyncOnClientChange();
      console.error(`[ws] client disconnected: ${clientId}`);
    });
  });

  return wss;
}
