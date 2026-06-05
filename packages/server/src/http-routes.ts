import { Router, json } from "express";
import type { Request, Response } from "express";
import type { VtxRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import type { MessageRouter } from "./message-router.js";
import { detectTrustedMode } from "./trusted-mode.js";
import { relaunchTrusted } from "./relauncher.js";

/** GET /trusted-mode:回当前 Chrome 是否带 flag(trusted)。popup 状态指示用。 */
export function trustedModeHandler(_req: Request, res: Response): void {
  res.json({ trustedMode: detectTrustedMode() });
}

/** POST /relaunch-trusted:触发带 flag 重启 Chrome(detached helper,立即返回)。 */
export function relaunchHandler(_req: Request, res: Response): void {
  relaunchTrusted();
  res.json({ ok: true });
}

export function createHttpRoutes(router: MessageRouter): Router {
  const app = Router();
  app.use(json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });

  app.post("/api/:namespace/:method", async (req, res) => {
    const action = `${req.params.namespace}.${req.params.method}`;
    const vtxReq: VtxRequest = {
      action,
      params: req.body,
      id: `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tabId: req.body?.tabId,
    };

    const resp = await router.routeToExtensionSync(vtxReq);
    const statusCode =
      !resp.error ? 200 :
      resp.error.code === VtxErrorCode.EXTENSION_NOT_CONNECTED ? 503 :
      resp.error.code === VtxErrorCode.TIMEOUT ? 504 :
      resp.error.code === VtxErrorCode.INVALID_PARAMS ? 400 :
      resp.error.code === VtxErrorCode.UNKNOWN_ACTION ? 404 : 500;
    res.status(statusCode).json(resp);
  });

  app.get("/api/:namespace/:method", async (req, res) => {
    const action = `${req.params.namespace}.${req.params.method}`;
    const vtxReq: VtxRequest = {
      action,
      params: req.query as Record<string, unknown>,
      id: `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tabId: req.query.tabId ? Number(req.query.tabId) : undefined,
    };

    const resp = await router.routeToExtensionSync(vtxReq);
    const statusCode = resp.error ? 500 : 200;
    res.status(statusCode).json(resp);
  });

  app.get("/trusted-mode", trustedModeHandler);
  app.post("/relaunch-trusted", relaunchHandler);

  return app;
}
