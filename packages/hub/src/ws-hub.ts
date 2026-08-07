/**
 * Author: qingwa
 * Description: WebSocket handshake, framing, and heartbeat layer for the hub.
 */
import type { Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  classifyFromAgent,
  classifyFromClient,
  VTX_WIRE_VERSION,
  type VtxHello,
  type VtxNotice,
  type VtxWelcome,
} from "@vortex-browser/shared";
import { type BrowserEntry, BrowserRegistry, type SessionEntry, SessionRegistry } from "./registry.js";
import { HubRouter } from "./router.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

interface Peer {
  role: "mcp" | "cli" | "browser-agent";
  id: string;
}

export interface WsHubOptions {
  httpServer: Server;
  sessions: SessionRegistry;
  browsers: BrowserRegistry;
  router: HubRouter;
  now?: () => number;
  hubVersion?: string;
}

export class WsHub {
  readonly wss: WebSocketServer;
  private readonly sessions: SessionRegistry;
  private readonly browsers: BrowserRegistry;
  private readonly router: HubRouter;
  private readonly now: () => number;
  private readonly hubVersion: string;
  private readonly peers = new WeakMap<WebSocket, Peer>();
  private readonly heartbeatTimers = new Map<WebSocket, ReturnType<typeof setInterval>>();

  constructor(options: WsHubOptions) {
    this.sessions = options.sessions;
    this.browsers = options.browsers;
    this.router = options.router;
    this.now = options.now ?? Date.now;
    this.hubVersion = options.hubVersion ?? "1.0.0";
    this.wss = new WebSocketServer({ server: options.httpServer, path: "/ws" });
    this.wss.on("error", () => {});
    this.wss.on("connection", (ws) => this.attach(ws));
  }

  sendToSession(sessionId: string, frame: object): void {
    const ws = this.sessions.get(sessionId)?.ws;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  sendToBrowser(browserId: string, frame: object): boolean {
    const ws = this.browsers.get(browserId)?.ws;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.close(1001, "hub shutting down");
    if (this.wss.clients.size === 0) {
      await new Promise<void>((resolve) => this.wss.close(() => resolve()));
      return;
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private attach(ws: WebSocket): void {
    let peer: Peer | undefined;
    let alive = true;
    let missedPongs = 0;
    ws.on("pong", () => {
      alive = true;
      missedPongs = 0;
    });

    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) missedPongs += 1;
      if (missedPongs >= 2) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimers.set(ws, heartbeat);

    ws.once("message", (data) => {
      peer = this.acceptHello(ws, data.toString());
      if (!peer) return;
      ws.on("message", (message) => this.handleMessage(ws, peer!, message.toString()));
    });
    ws.on("close", () => {
      const timer = this.heartbeatTimers.get(ws);
      if (timer) clearInterval(timer);
      this.heartbeatTimers.delete(ws);
      if (!peer) return;
      if (peer.role === "browser-agent") {
        this.router.unregisterBrowser(peer.id, ws);
      } else {
        this.router.unregisterSession(peer.id, ws);
      }
    });
  }

  private acceptHello(ws: WebSocket, payload: string): Peer | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      ws.close(1008, "invalid hello");
      return undefined;
    }
    if (!isRecord(raw) || raw.type !== "hello") {
      ws.close(1008, "hello required");
      return undefined;
    }
    const hello = raw.role === "browser-agent" ? classifyFromAgent(raw) : classifyFromClient(raw);
    if (!hello || hello.type !== "hello") {
      ws.close(1008, "invalid hello");
      return undefined;
    }
    if (isBrowserHello(hello)) return this.acceptBrowser(ws, hello);
    if (!isSessionHello(hello)) {
      ws.close(1008, "invalid hello");
      return undefined;
    }
    return this.acceptSession(ws, hello);
  }

  private acceptSession(ws: WebSocket, hello: VtxHello & { role: "mcp" | "cli" }): Peer {
    const sessionId = hello.sessionId ?? `${hello.role}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.sessions.get(sessionId);
    if (existing?.ws && existing.ws !== ws) {
      // 不先告知就关掉，--follow 的对端只看到静默断流，无从判断自己被顶了
      const notice: VtxNotice = {
        type: "notice",
        notice: "session-replaced",
        reason: `session ${sessionId} was taken over by a newer connection`,
      };
      try {
        existing.ws.send(JSON.stringify(notice));
      } catch {
        // 对端已经不可写，close 仍要执行
      }
      existing.ws.close(1000, "replaced by same-session reconnect");
    }
    const session: SessionEntry = existing ?? {
      sessionId,
      role: hello.role,
      label: hello.label ?? sessionId,
      ws: null,
      wireVersion: hello.wireVersion,
      connectedAt: this.now(),
      lastSeenAt: this.now(),
      browserId: null,
      lastBrowserId: null,
      rebindUntil: 0,
      buffer: [],
      ownedTabs: new Set(),
      currentTabId: null,
      claiming: null,
      pinned: false,
      strictTab: process.env.VORTEX_STRICT_TAB === "1",
    };
    session.ws = ws;
    session.role = hello.role;
    session.label = hello.label ?? session.label;
    session.wireVersion = hello.wireVersion;
    session.connectedAt = this.now();
    session.lastSeenAt = this.now();
    session.pinned = hello.preferBrowserId !== undefined;
    if (hello.preferBrowserId) session.browserId = hello.preferBrowserId;
    this.sessions.set(session);
    const assignedBrowserId = session.rebindUntil > this.now() ? null : this.router.assignSession(session, false);
    const welcome: VtxWelcome = {
      type: "welcome",
      wireVersion: VTX_WIRE_VERSION,
      hubVersion: this.hubVersion,
      sessionId,
      assignedBrowserId,
      assignedBrowserLabel: assignedBrowserId ? this.browsers.get(assignedBrowserId)?.label ?? null : null,
      strictTab: session.strictTab,
    };
    ws.send(JSON.stringify(welcome));
    return { role: hello.role, id: sessionId };
  }

  private acceptBrowser(ws: WebSocket, hello: VtxHello & { role: "browser-agent" }): Peer {
    const browserId = hello.browserId ?? `browser-${this.now()}`;
    const existing = this.browsers.get(browserId);
    if (existing?.ws && existing.ws !== ws) {
      this.router.failAgentCommandsOnReconnect(browserId, existing.ws);
      existing.ws.close(1000, "replaced by browser reconnect");
    }
    const replaced = existing?.ws !== undefined && existing.ws !== ws;
    const entry: BrowserEntry = existing && replaced
      ? {
        ...existing,
        sessions: new Set(existing.sessions),
        tabOwner: new Map(existing.tabOwner),
        opener: new Map(existing.opener),
      }
      : existing ?? {
      browserId,
      label: hello.label ?? browserId,
      ws,
      peerVersion: hello.peerVersion ?? "unknown",
      extensionVersion: hello.extensionVersion,
      buildStamp: hello.buildStamp,
      extDist: hello.extDist,
      repoRoot: hello.repoRoot,
      connectedAt: this.now(),
      lastSeenAt: this.now(),
      nmConnected: true,
      sessions: new Set(),
      tabOwner: new Map(),
      opener: new Map(),
    };
    entry.ws = ws;
    entry.label = hello.label ?? entry.label;
    entry.peerVersion = hello.peerVersion ?? entry.peerVersion;
    entry.extensionVersion = hello.extensionVersion ?? entry.extensionVersion;
    entry.buildStamp = hello.buildStamp ?? entry.buildStamp;
    entry.extDist = hello.extDist ?? entry.extDist;
    entry.repoRoot = hello.repoRoot ?? entry.repoRoot;
    entry.lastSeenAt = this.now();
    entry.nmConnected = true;
    ws.send(JSON.stringify({
      type: "welcome",
      wireVersion: VTX_WIRE_VERSION,
      hubVersion: this.hubVersion,
      browserId,
    } satisfies VtxWelcome));
    this.router.registerBrowser(entry);
    return { role: "browser-agent", id: browserId };
  }

  private handleMessage(ws: WebSocket, peer: Peer, payload: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      ws.close(1008, "invalid frame");
      return;
    }
    const frame = peer.role === "browser-agent" ? classifyFromAgent(raw) : classifyFromClient(raw);
    if (!frame) return;
    if (frame.type === "heartbeat") {
      if (peer.role === "browser-agent") {
        this.router.handleBrowserHeartbeat(peer.id, frame.nmConnected ?? true, frame.timestamp);
      } else {
        const session = this.sessions.get(peer.id);
        if (session) session.lastSeenAt = frame.timestamp;
      }
      return;
    }
    if (peer.role === "browser-agent") {
      if (frame.type === "response" || frame.type === "event" || frame.type === "agent-result") {
        this.router.handleAgentFrame(peer.id, frame, ws);
      }
      return;
    }
    if (frame.type === "request") this.router.handleRequest(peer.id, frame);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBrowserHello(hello: VtxHello): hello is VtxHello & { role: "browser-agent" } {
  return hello.role === "browser-agent";
}

function isSessionHello(hello: VtxHello): hello is VtxHello & { role: "mcp" | "cli" } {
  return hello.role === "mcp" || hello.role === "cli";
}
