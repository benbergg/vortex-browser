/**
 * Author: qingwa
 * Description: Minimal health and graceful shutdown HTTP routes for the hub.
 */
import { Router } from "express";

export interface HubRouteOptions {
  now: () => number;
  nmConnected: () => boolean;
  shutdown: () => Promise<void>;
}

export function createHttpRoutes(options: HubRouteOptions): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", nmConnected: options.nmConnected(), timestamp: options.now() });
  });
  router.post("/hub/shutdown", (_req, res) => {
    res.json({ ok: true });
    setImmediate(() => void options.shutdown());
  });
  return router;
}
