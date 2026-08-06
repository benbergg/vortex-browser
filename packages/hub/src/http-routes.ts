/**
 * Author: qingwa
 * Description: Minimal health and graceful shutdown HTTP routes for the hub.
 */
import { Router } from "express";
import type { BrowserRegistry, SessionRegistry } from "./registry.js";

export interface HubRouteOptions {
  now: () => number;
  nmConnected: () => boolean;
  shutdown: () => Promise<void>;
  hubVersion?: string;
  browsers?: BrowserRegistry;
  sessions?: SessionRegistry;
}

export function createHttpRoutes(options: HubRouteOptions): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    const browsers = options.browsers
      ? [...options.browsers.values()]
        .sort((a, b) => a.browserId.localeCompare(b.browserId))
        .map((browser) => ({
          browserId: browser.browserId,
          label: browser.label,
          nmConnected: browser.nmConnected,
          extensionVersion: browser.extensionVersion ?? null,
          buildStamp: browser.buildStamp ?? null,
          extDist: browser.extDist ?? null,
          sessions: [...browser.sessions].sort(),
        }))
      : [];
    const sessions = options.sessions
      ? [...options.sessions.values()]
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((session) => ({
          sessionId: session.sessionId,
          role: session.role,
          label: session.label,
          browserId: session.browserId,
          currentTabId: session.currentTabId,
        }))
      : [];
    res.json({
      status: "ok",
      hubVersion: options.hubVersion ?? "1.0.0",
      nmConnected: options.nmConnected(),
      timestamp: options.now(),
      browsers,
      sessions,
    });
  });
  router.post("/hub/shutdown", (_req, res) => {
    res.json({ ok: true });
    setImmediate(() => void options.shutdown());
  });
  return router;
}
