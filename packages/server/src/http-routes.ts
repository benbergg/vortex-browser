import { Router, json } from "express";
import type { Request, Response } from "express";
import type { VtxRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import type { MessageRouter } from "./message-router.js";
import { detectTrustedMode } from "./trusted-mode.js";
import { relaunchTrusted } from "./relauncher.js";
import { resolveExtensionDist, readBuildStamp } from "./ext-dist.js";

/** GET /trusted-mode:回当前 Chrome 是否带 flag(trusted)。popup 状态指示用。 */
export function trustedModeHandler(_req: Request, res: Response): void {
  res.json({ trustedMode: detectTrustedMode() });
}

/** POST /relaunch-trusted:触发带 flag 重启 Chrome(detached helper,立即返回)。 */
export function relaunchHandler(_req: Request, res: Response): void {
  relaunchTrusted();
  res.json({ ok: true });
}

/**
 * POST /dev/reload-extension:dev-only 按需触发扩展自重载(O-3b watcher 的主动版)。
 *
 * 不等待重载完成(`chrome.runtime.reload()` 会杀掉本 server 进程——新 SW spawn 新
 * host,killOldProcess 收旧进程),立即返回。「重载是否生效」由存活的 MCP 进程轮询
 * diagnostics.version 的 buildStamp 来验证(见 mcp __mcp_dev_reload__)。
 *
 * 返回 targetStamp(本 server 服务的 dist/build-stamp.txt)= 期望加载的扩展构建戳;
 * MCP 用它与扩展实际上报的 buildStamp 比对,不一致即 C1 路径错配。
 */
export function devReloadHandler(router: MessageRouter): (req: Request, res: Response) => void {
  return (_req, res) => {
    if (!router.isNmConnected()) {
      res.status(503).json({
        ok: false,
        error: { code: VtxErrorCode.EXTENSION_NOT_CONNECTED, message: "Extension is not connected" },
      });
      return;
    }
    const extDist = resolveExtensionDist();
    const targetStamp = readBuildStamp(extDist);
    router.pushReloadExtension("dev_reload");
    res.json({ ok: true, triggered: true, targetStamp, extDist });
  };
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
  app.post("/dev/reload-extension", devReloadHandler(router));

  return app;
}
