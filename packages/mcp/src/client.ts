import WebSocket from "ws";
import type { VtxEvent, VtxRequest, VtxResponse } from "@vortex-browser/shared";
import {
  hubDeadlineFor,
  transportTimeoutFor,
  VtxEventType,
  VTX_WIRE_VERSION,
} from "@vortex-browser/shared";
import { eventStore } from "./lib/event-store.js";
import { currentSessionId } from "./lib/session-id.js";

// hub 把连接的第一帧当 hello，不是 hello 就 close(1008)。等 welcome 而非 open 才算连上，
// 否则请求会赶在握手完成前发出去。超时后仍放行：对端可能是不认 hello 的旧 server。
const WELCOME_TIMEOUT_MS = 1500;

interface PendingRequest {
  resolve: (resp: VtxResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// 瞬态错误白名单（请求未触达场景，可安全重试）
const TRANSIENT_PATTERNS = [
  "Cannot access contents",
  "No tab with id",
  "Connection closed",
  "Failed to connect",
];

function isTransient(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

export function buildHello(sessionId: string): Record<string, unknown> {
  const pref = process.env.VORTEX_BROWSER?.trim();
  return {
    type: "hello",
    wireVersion: VTX_WIRE_VERSION,
    role: "mcp",
    sessionId,
    label: sessionId,
    ...(pref ? { preferBrowser: pref } : {}),
  };
}

class VortexClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private port: number;
  private readonly sessionId: string;

  constructor(port: number) {
    this.port = port;
    this.sessionId = currentSessionId();
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${this.port}/ws`);
      const connectTimeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Failed to connect to vortex-server at localhost:${this.port} (timeout)`));
      }, 5000);

      let settled = false;
      let welcomeTimer: ReturnType<typeof setTimeout> | undefined;
      const ready = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        this.ws = ws;
        this.connecting = null;
        resolve();
      };

      ws.on("open", () => {
        clearTimeout(connectTimeout);
        ws.send(JSON.stringify(buildHello(this.sessionId)));
        welcomeTimer = setTimeout(ready, WELCOME_TIMEOUT_MS);
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "welcome") {
            ready();
            return;
          }
          // tool response：按 id 路由到 pending
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            p.resolve(msg as VtxResponse);
            return;
          }
          // 事件：无 id，有 event 字段（来自 vortex-server 透传的 VtxEvent）
          if (typeof msg.event === "string" && typeof msg.timestamp === "number") {
            eventStore.ingest(msg as VtxEvent);
          }
        } catch (err) {
          console.error("[vortex-mcp] message parse error:", err);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(connectTimeout);
        clearTimeout(welcomeTimer);
        if (!settled) {
          settled = true;
          this.connecting = null;
          reject(new Error(`Failed to connect to vortex-server at localhost:${this.port}: ${err.message}`));
        }
      });

      ws.on("close", () => {
        clearTimeout(welcomeTimer);
        const wasConnected = this.ws !== null;
        this.ws = null;
        this.connecting = null;
        // 握手期就被关掉（hub 对非法 hello 回 1008）：别等 welcome 超时把死连接当可用
        if (!settled) {
          settled = true;
          reject(new Error(`Connection closed during handshake with vortex-server at localhost:${this.port}`));
        }
        // reject all pending
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Connection closed before response"));
        }
        this.pending.clear();
        // F5: 曾经成功连接过，则把意外断开作为 EXTENSION_DISCONNECTED 事件
        // 注入 eventStore。首次连接失败（wasConnected=false）不推，避免误报。
        if (wasConnected) {
          eventStore.ingest({
            event: VtxEventType.EXTENSION_DISCONNECTED,
            data: { reason: "vortex-server WebSocket closed" },
            level: "urgent",
            timestamp: Date.now(),
          });
        }
      });
    });

    return this.connecting;
  }

  private async requestOnce(
    action: string,
    params: Record<string, unknown>,
    tabId: number | undefined,
    hubTimeoutMs: number,
  ): Promise<VtxResponse> {
    await this.ensureConnected();
    const id = `mcp-${++this.requestCounter}-${Date.now()}`;
    // 传输超时比 hub 多一档，让 hub 的 TIMEOUT（带 action 与 hint）先到达调用方，
    // 而不是双方同 deadline 竞 race 后返回本地的 "no response"。
    const transportMs = transportTimeoutFor(hubTimeoutMs);
    return new Promise<VtxResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: no response for ${action} after ${transportMs}ms`));
      }, transportMs);

      this.pending.set(id, { resolve, reject, timer });

      const req: VtxRequest = {
        type: "request",
        action,
        params,
        id,
        sessionId: this.sessionId,
        timeoutMs: hubTimeoutMs,
        ...(tabId != null ? { tabId } : {}),
      };
      this.ws!.send(JSON.stringify(req));
    });
  }

  /**
   * 发送请求（含瞬态错误自动重试 1 次）。
   * @param hubTimeoutMs hub pending 的 deadline；省略时按 action 预算推导，
   *   本地传输超时再由它加一档推出
   */
  async request(
    action: string,
    params: Record<string, unknown>,
    tabId?: number,
    hubTimeoutMs?: number,
    maxRetries = 1,
  ): Promise<VtxResponse> {
    // 缺省不能是扁平常量:内层预算 >30s 的 action 会让 hub 先 fire,归因就丢了
    const hubMs = hubTimeoutMs ?? hubDeadlineFor(action, params.timeout as number | undefined);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.requestOnce(action, params, tabId, hubMs);
      } catch (err) {
        lastErr = err;
        if (attempt === maxRetries || !isTransient(err)) throw err;
        // 指数退避：500ms, 1000ms, ...
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}

// 单例
let singleton: VortexClient | null = null;

/**
 * 发送请求到 vortex-server 并等待响应（复用长连接 + 自动重试）。
 */
export function sendRequest(
  action: string,
  params: Record<string, unknown>,
  port: number,
  tabId?: number,
  hubTimeoutMs?: number,
): Promise<VtxResponse> {
  if (!singleton) singleton = new VortexClient(port);
  return singleton.request(action, params, tabId, hubTimeoutMs);
}
