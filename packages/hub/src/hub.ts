/**
 * Author: qingwa
 * Description: Composes the hub HTTP server, WebSocket transport, registries, and router.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { BrowserRegistry, SessionRegistry } from "./registry.js";
import { HubRouter } from "./router.js";
import { createHttpRoutes } from "./http-routes.js";
import { WsHub } from "./ws-hub.js";
import type { PendingTable } from "./pending.js";

export interface HubOptions {
  port?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  onWarn?: (message: string, details: object) => void;
}

export interface HubHandle {
  port: number;
  sessions: SessionRegistry;
  browsers: BrowserRegistry;
  pending: PendingTable;
  close(): Promise<void>;
}

export async function createHub(options: HubOptions = {}): Promise<HubHandle> {
  const now = options.now ?? (() => Date.now());
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
    sendToSession: (sessionId, frame) => wsHub?.sendToSession(sessionId, frame),
    sendToBrowser: (browserId, frame) => wsHub?.sendToBrowser(browserId, frame),
  });
  const app = express();
  const httpServer = createServer(app);
  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      router.pending.clear();
      await wsHub?.close();
      await closeHttpServer(httpServer);
    })();
    return closePromise;
  };
  app.use(createHttpRoutes({
    now,
    nmConnected: () => [...browsers.values()].some((browser) => browser.nmConnected),
    shutdown: close,
  }));
  wsHub = new WsHub({ httpServer, sessions, browsers, router, now });
  const port = await listen(httpServer, options.port ?? 0);
  return { port, sessions, browsers, pending: router.pending, close };
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
