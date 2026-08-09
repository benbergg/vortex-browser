/**
 * Author: qingwa
 * Description: Minimal health and graceful shutdown HTTP routes for the hub.
 */
import { Router, type Request, type Response } from "express";
import {
  VtxErrorCode,
  type VtxAgentResult,
  type VtxErrorPayload,
  type VtxRequest,
  type VtxResponse,
} from "@vortex-browser/shared";
import type { HubHandle } from "./hub.js";
import type { BrowserRegistry, SessionEntry, SessionRegistry } from "./registry.js";
import { sweepIdleVirtualSessions } from "./virtual-session.js";

const DEFAULT_VIRTUAL_SESSION_IDLE_MS = 10 * 60_000;
const DEFAULT_VIRTUAL_SESSION_REQUEST_TIMEOUT_MS = 35_000;
let httpRequestCounter = 0;

interface HttpWaiter {
  resolve: (response: VtxResponse) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface HttpSessionWaiters {
  pending: Map<string, HttpWaiter>;
  sink: (frame: object) => void;
}

export interface HubRouteOptions {
  now: () => number;
  nmConnected: () => boolean;
  shutdown: () => Promise<void>;
  hubVersion?: string;
  browsers?: BrowserRegistry;
  sessions?: SessionRegistry;
  sendAgentCommand: HubHandle["sendAgentCommand"];
  getVirtualSession: (name: string, browserPref?: string) => SessionEntry;
  submitRequest: (sessionId: string, request: VtxRequest) => void;
  hasPending: (sessionId: string) => boolean;
  onVirtualSessionRemoved?: (session: SessionEntry) => void;
  virtualSessionIdleMs?: number;
  virtualSessionRequestTimeoutMs?: number;
}

export function createHttpRoutes(options: HubRouteOptions): Router {
  const router = Router();
  const waitersBySession = new WeakMap<SessionEntry, HttpSessionWaiters>();
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
  router.post("/api/:ns/:method", async (req, res) => {
    if (options.sessions) {
      sweepIdleVirtualSessions(
        { sessions: options.sessions, now: options.now },
        options.virtualSessionIdleMs ?? DEFAULT_VIRTUAL_SESSION_IDLE_MS,
        options.hasPending,
        options.onVirtualSessionRemoved,
      );
    }

    const body = isRecord(req.body) ? req.body : {};
    const hasBodyTabId = Object.prototype.hasOwnProperty.call(body, "tabId");
    const rawTabId = hasBodyTabId ? body.tabId : req.get("x-vortex-tab");
    const tabId = parseTabId(rawTabId);
    if (tabId === null) {
      sendError(res, 400, VtxErrorCode.INVALID_PARAMS, "tabId must be an integer");
      return;
    }

    const params = { ...body };
    delete params.tabId;
    const sessionHeader = req.get("x-vortex-session");
    const sessionName = sessionHeader && sessionHeader.length > 0
      ? sessionHeader
      : `cli-${process.env.USER ?? "default"}`;
    const preferredBrowser = req.get("x-vortex-browser") || undefined;
    // 不带 browser 头 = 本次无偏好，须解除既有偏好
    const session = options.getVirtualSession(sessionName, preferredBrowser);
    const request: VtxRequest = {
      action: `${req.params.ns}.${req.params.method}`,
      params,
      id: `http-${++httpRequestCounter}`,
      ...(tabId !== undefined ? { tabId } : {}),
    };

    try {
      const response = await waitForHttpResponse(
        options,
        waitersBySession,
        session,
        request,
        options.virtualSessionRequestTimeoutMs ?? DEFAULT_VIRTUAL_SESSION_REQUEST_TIMEOUT_MS,
      );
      sendHttpResponse(res, response);
    } catch (error: unknown) {
      const payload = toErrorPayload(error);
      sendError(res, statusForError(payload.code), payload.code, payload.message, payload);
    }
  });
  router.post("/hub/shutdown", (_req, res) => {
    res.json({ ok: true });
    setImmediate(() => void options.shutdown());
  });
  router.get("/trusted-mode", async (req, res) => {
    const selection = selectBrowser(options, queryBrowserId(req));
    if (!selection.ok) {
      sendError(res, selection.status, selection.code, selection.message);
      return;
    }
    try {
      const result = await options.sendAgentCommand(selection.browserId, "trusted-mode");
      if (result.error) {
        sendAgentError(res, result);
        return;
      }
      res.json({ trustedMode: result.result === true });
    } catch (error: unknown) {
      sendCaughtError(res, error);
    }
  });
  router.post("/relaunch-trusted", async (_req, res) => {
    if ((options.browsers?.size ?? 0) > 1) {
      sendError(res, 409, VtxErrorCode.INVALID_PARAMS, "多浏览器下无法按 profile 重启，这是已知限制");
      return;
    }
    const selection = selectBrowser(options);
    if (!selection.ok) {
      sendError(res, selection.status, selection.code, selection.message);
      return;
    }
    try {
      const result = await options.sendAgentCommand(selection.browserId, "relaunch-trusted");
      if (result.error) {
        sendAgentError(res, result);
        return;
      }
      res.json({ ok: true });
    } catch (error: unknown) {
      sendCaughtError(res, error);
    }
  });
  router.post("/dev/reload-extension", async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const requestedBrowserId = typeof body.browserId === "string" && body.browserId.length > 0
      ? body.browserId
      : undefined;
    if (body.all === true) {
      const browserIds = listBrowserIds(options);
      if (browserIds.length === 0) {
        sendError(res, 503, VtxErrorCode.EXTENSION_NOT_CONNECTED, "没有可用 browser");
        return;
      }
      const results = await Promise.all(browserIds.map(async (browserId) => {
        try {
          const result = await options.sendAgentCommand(browserId, "reload-extension");
          return result.error
            ? { browserId, ok: false, error: result.error }
            : { browserId, ok: true, result: result.result };
        } catch (error: unknown) {
          return { browserId, ok: false, error: toErrorPayload(error) };
        }
      }));
      res.json({ ok: results.every((result) => result.ok), results });
      return;
    }
    const selection = selectBrowser(options, requestedBrowserId);
    if (!selection.ok) {
      sendError(res, selection.status, selection.code, selection.message);
      return;
    }
    try {
      // 先取 dist 信息：MCP 靠 targetStamp 做 C1 路径错配强校验，缺了这条检查恒为假
      const dist = await readExtDistInfo(options, selection.browserId);
      const result = await options.sendAgentCommand(selection.browserId, "reload-extension");
      if (result.error) {
        sendAgentError(res, result);
        return;
      }
      res.json({ ok: true, triggered: true, targetStamp: dist.buildStamp, extDist: dist.extDist });
    } catch (error: unknown) {
      sendCaughtError(res, error);
    }
  });
  return router;
}

type BrowserSelection =
  | { ok: true; browserId: string }
  | { ok: false; status: number; code: VtxErrorPayload["code"]; message: string };

function selectBrowser(options: HubRouteOptions, requestedBrowserId?: string): BrowserSelection {
  const browserIds = listBrowserIds(options);
  if (browserIds.length === 0) {
    return {
      ok: false,
      status: 503,
      code: VtxErrorCode.EXTENSION_NOT_CONNECTED,
      message: "没有可用 browser",
    };
  }
  if (requestedBrowserId !== undefined) {
    if (!browserIds.includes(requestedBrowserId)) {
      return {
        ok: false,
        status: 404,
        code: VtxErrorCode.INVALID_PARAMS,
        message: `未知 browserId: ${requestedBrowserId}`,
      };
    }
    return { ok: true, browserId: requestedBrowserId };
  }
  if (browserIds.length > 1) {
    return {
      ok: false,
      status: 400,
      code: VtxErrorCode.INVALID_PARAMS,
      message: `browserId 必填，可选 browserId: ${browserIds.join(", ")}`,
    };
  }
  return { ok: true, browserId: browserIds[0] };
}

interface ExtDistInfo {
  extDist: string | null;
  buildStamp: string | null;
}

// 旧 agent 不认 ext-dist-info；拿不到就降级为 null，不能因此让重载整体失败
async function readExtDistInfo(options: HubRouteOptions, browserId: string): Promise<ExtDistInfo> {
  try {
    const info = await options.sendAgentCommand(browserId, "ext-dist-info");
    if (info.error || !isRecord(info.result)) return { extDist: null, buildStamp: null };
    return {
      extDist: typeof info.result.extDist === "string" ? info.result.extDist : null,
      buildStamp: typeof info.result.buildStamp === "string" ? info.result.buildStamp : null,
    };
  } catch {
    return { extDist: null, buildStamp: null };
  }
}

function listBrowserIds(options: HubRouteOptions): string[] {
  return options.browsers
    ? [...options.browsers.values()]
      .map((browser) => browser.browserId)
      .sort((a, b) => a.localeCompare(b))
    : [];
}

function queryBrowserId(req: Request): string | undefined {
  return typeof req.query.browserId === "string" && req.query.browserId.length > 0
    ? req.query.browserId
    : undefined;
}

function parseTabId(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function waitForHttpResponse(
  options: HubRouteOptions,
  waitersBySession: WeakMap<SessionEntry, HttpSessionWaiters>,
  session: SessionEntry,
  request: VtxRequest,
  timeoutMs: number,
): Promise<VtxResponse> {
  const state = getHttpSessionWaiters(waitersBySession, session);
  session.sink = state.sink;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const waiter = removeHttpWaiter(state, session, request.id);
      waiter?.reject({
        code: VtxErrorCode.TIMEOUT,
        message: `Request ${request.action} timed out`,
        recoverable: false,
      } satisfies VtxErrorPayload);
    }, Math.max(0, timeoutMs));
    state.pending.set(request.id, { resolve, reject, timeout });
    try {
      options.submitRequest(session.sessionId, request);
    } catch (error: unknown) {
      const waiter = removeHttpWaiter(state, session, request.id);
      waiter?.reject(error);
    }
  });
}

function getHttpSessionWaiters(
  waitersBySession: WeakMap<SessionEntry, HttpSessionWaiters>,
  session: SessionEntry,
): HttpSessionWaiters {
  const existing = waitersBySession.get(session);
  if (existing) return existing;

  const pending = new Map<string, HttpWaiter>();
  let sink: (frame: object) => void;
  sink = (frame) => {
    if (!isRecord(frame) || frame.type !== "response" || typeof frame.id !== "string") return;
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    removeHttpWaiter({ pending, sink }, session, frame.id);
    waiter.resolve(frame as unknown as VtxResponse);
  };
  const state = { pending, sink };
  waitersBySession.set(session, state);
  return state;
}

function removeHttpWaiter(
  state: HttpSessionWaiters,
  session: SessionEntry,
  requestId: string,
): HttpWaiter | undefined {
  const waiter = state.pending.get(requestId);
  if (!waiter) return undefined;
  state.pending.delete(requestId);
  clearTimeout(waiter.timeout);
  if (state.pending.size === 0 && session.sink === state.sink) session.sink = undefined;
  return waiter;
}

function sendHttpResponse(res: Response, response: VtxResponse): void {
  if (response.error) {
    sendError(
      res,
      statusForError(response.error.code),
      response.error.code,
      response.error.message,
      response.error,
    );
    return;
  }
  res.status(200).json({ result: response.result });
}

function statusForError(code: VtxErrorPayload["code"]): number {
  if (code === VtxErrorCode.INVALID_PARAMS) return 400;
  if (code === VtxErrorCode.TAB_NOT_FOUND) return 404;
  if (code === VtxErrorCode.EXTENSION_NOT_CONNECTED) return 503;
  if (code === VtxErrorCode.TIMEOUT) return 504;
  return 502;
}

function sendAgentError(res: Response, result: VtxAgentResult): void {
  const error = result.error;
  if (!error) return;
  sendError(res, 502, error.code, error.message, error);
}

function sendCaughtError(res: Response, error: unknown): void {
  const payload = toErrorPayload(error);
  sendError(res, 502, payload.code, payload.message, payload);
}

function sendError(
  res: Response,
  status: number,
  code: VtxErrorPayload["code"],
  message: string,
  payload?: VtxErrorPayload,
): void {
  const error = payload ?? { code, message, recoverable: false };
  res.status(status).json({ message: error.message, error });
}

function toErrorPayload(error: unknown): VtxErrorPayload {
  if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
    return error as unknown as VtxErrorPayload;
  }
  return {
    code: VtxErrorCode.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
