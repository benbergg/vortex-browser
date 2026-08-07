/**
 * Author: qingwa
 * Description: Composes the hub HTTP server, WebSocket transport, registries, and router.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import {
  VtxErrorCode,
  type VtxAgentCommand,
  type VtxAgentResult,
  type VtxErrorPayload,
} from "@vortex-browser/shared";
import { BrowserRegistry, SessionRegistry, type SessionEntry } from "./registry.js";
import { HubRouter } from "./router.js";
import { createHttpRoutes } from "./http-routes.js";
import { WsHub } from "./ws-hub.js";
import type { PendingTable } from "./pending.js";
import { getOrCreateVirtualSession as getOrCreateVirtualSessionEntry } from "./virtual-session.js";

export interface HubOptions {
  port?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  onWarn?: (message: string, details: object) => void;
  hubVersion?: string;
  shutdownTimeoutMs?: number;
  onShutdownComplete?: () => void;
}

export interface HubHandle {
  port: number;
  sessions: SessionRegistry;
  browsers: BrowserRegistry;
  pending: PendingTable;
  getOrCreateVirtualSession(
    name: string,
    options?: VirtualSessionOptions,
  ): SessionEntry;
  sendAgentCommand(
    browserId: string,
    command: VtxAgentCommand["command"],
    reason?: string,
  ): Promise<VtxAgentResult>;
  close(): Promise<void>;
}

export interface VirtualSessionOptions {
  sink?: (frame: object) => void;
  preferBrowserId?: string;
  pinned?: boolean;
}

export async function createHub(options: HubOptions = {}): Promise<HubHandle> {
  const now = options.now ?? (() => Date.now());
  const hubVersion = options.hubVersion ?? "1.0.0";
  const shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? 5_000);
  const sessions = new SessionRegistry();
  const browsers = new BrowserRegistry();
  let wsHub: WsHub | undefined;
  let closePromise: Promise<void> | undefined;
  const router = new HubRouter({
    sessions,
    browsers,
    now,
    requestTimeoutMs: options.requestTimeoutMs,
    onWarn: options.onWarn,
    sendToSession: (sessionId, frame) => {
      const session = sessions.get(sessionId);
      if (session?.sink) {
        session.sink(frame);
        return;
      }
      wsHub?.sendToSession(sessionId, frame);
    },
    sendToBrowser: (browserId, frame) => wsHub?.sendToBrowser(browserId, frame) ?? false,
  });
  const getOrCreateVirtualSession: HubHandle["getOrCreateVirtualSession"] = (name, options = {}) => {
    const existing = sessions.get(name);
    const session = getOrCreateVirtualSessionEntry({ sessions, now }, name);
    if (options.sink !== undefined) session.sink = options.sink;
    if (options.preferBrowserId !== undefined) session.browserId = options.preferBrowserId;
    if (options.pinned !== undefined) session.pinned = options.pinned;
    if (!existing) router.assignSession(session, false);
    return session;
  };
  const sendAgentCommand: HubHandle["sendAgentCommand"] = (browserId, command, reason) =>
    router.sendAgentCommand(browserId, command, reason);
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const shutdownNotice = { type: "notice", notice: "hub-shutdown" } as const;
      for (const session of sessions.values()) wsHub?.sendToSession(session.sessionId, shutdownNotice);
      for (const browser of browsers.values()) wsHub?.sendToBrowser(browser.browserId, shutdownNotice);
      const routerShutdown = router.beginShutdown();

      const httpClosePromise = closeHttpServer(httpServer);
      void httpClosePromise.catch(() => {});
      await routerShutdown;
      const drained = await router.pending.waitForEmpty(shutdownTimeoutMs);
      if (!drained) router.pending.failAll(shutdownTimeoutError());
      await wsHub?.close();
      await httpClosePromise;
      options.onShutdownComplete?.();
    })();
    return closePromise;
  };
  app.use(createHttpRoutes({
    now,
    nmConnected: () => [...browsers.values()].some((browser) => browser.nmConnected),
    shutdown: close,
    hubVersion,
    browsers,
    sessions,
    sendAgentCommand,
  }));
  wsHub = new WsHub({ httpServer, sessions, browsers, router, now, hubVersion });
  const port = await listen(httpServer, options.port ?? 0);
  return {
    port,
    sessions,
    browsers,
    pending: router.pending,
    getOrCreateVirtualSession,
    sendAgentCommand,
    close,
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Hub server did not expose a TCP address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function shutdownTimeoutError(): VtxErrorPayload {
  return {
    code: VtxErrorCode.TIMEOUT,
    message: "Hub shutdown timed out waiting for a pending request",
    recoverable: false,
  };
}
