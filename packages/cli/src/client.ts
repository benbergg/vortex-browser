/**
 * Description: Provides HTTP action requests and WebSocket subscriptions for the CLI.
 */
import WebSocket from "ws";
import {
  VTX_WIRE_VERSION,
  hubDeadlineFor,
  transportTimeoutFor,
  type VtxEvent,
  type VtxRequest,
  type VtxResponse,
} from "@vortex-browser/shared";
import { resolveSessionName } from "./session.js";

export interface ClientOptions {
  port: number;
  session?: string;
  baseUrl?: string;
  tabId?: number;
  follow?: boolean;
  onEvent?: (event: VtxEvent) => void;
}

let requestCounter = 0;

function nextRequestId(): string {
  return `cli-${++requestCounter}-${Date.now()}`;
}

function splitAction(action: string): { namespace: string; method: string } {
  const separator = action.indexOf(".");
  if (separator <= 0 || separator === action.length - 1) {
    throw new Error(`Invalid action "${action}": expected <namespace>.<method>`);
  }
  return {
    namespace: action.slice(0, separator),
    method: action.slice(separator + 1),
  };
}

function resolveBaseUrl(opts: ClientOptions): string {
  return (opts.baseUrl ?? `http://127.0.0.1:${opts.port}`).replace(/\/$/, "");
}

function resolveWebSocketUrl(opts: ClientOptions): string {
  const url = new URL(`${resolveBaseUrl(opts)}/ws`);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseResponseBody(response: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function httpErrorMessage(body: unknown, status: number, statusText: string): string {
  if (isRecord(body) && typeof body.message === "string") return body.message;
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message;
  }
  if (typeof body === "string" && body.length > 0) return body;
  if (body !== undefined) {
    try {
      return `HTTP ${status}: ${JSON.stringify(body)}`;
    } catch {
      return `HTTP ${status}`;
    }
  }
  return `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
}

/**
 * CLI 非 2xx 的错误渲染：保留服务端的 code / hint / recoverable / context，
 * 形态与 MCP 层 `Error [CODE]: msg + hint` 对齐（见 packages/mcp/src/tools/dispatch.ts）。
 * 缺 hint 不编造 —— 服务端没给就不出现。
 */
export function formatCliError(payload: {
  code?: string; message: string; hint?: string; recoverable?: boolean; context?: unknown;
}): string {
  const head = payload.code ? `Error [${payload.code}]: ${payload.message}` : payload.message;
  const parts = [head];
  if (payload.hint) parts.push(`hint: ${payload.hint}`);
  if (payload.recoverable !== undefined) parts.push(`recoverable: ${payload.recoverable}`);
  if (payload.context !== undefined) parts.push(`context: ${JSON.stringify(payload.context)}`);
  return parts.join("\n");
}

/**
 * 非 2xx 的错误体有两种形态：hub 发的 `{message, error:{code,message,hint,...}}`
 * 与扁平的 `{code,message,hint,...}`。两层都取 code/message/hint/recoverable/context；
 * body 里没有结构化错误时退回 httpErrorMessage 的裸 message（既有兜底文案不变）。
 */
function cliErrorPayload(
  body: unknown,
  status: number,
  statusText: string,
): {
  code?: string;
  message: string;
  hint?: string;
  recoverable?: boolean;
  context?: unknown;
} {
  const source = isRecord(body) && isRecord(body.error) ? body.error : body;
  const structured = isRecord(source) ? source : undefined;
  const code = typeof structured?.code === "string" ? structured.code : undefined;
  const rawMessage = typeof structured?.message === "string" ? structured.message : undefined;
  if (code === undefined && rawMessage === undefined) {
    return { message: httpErrorMessage(body, status, statusText) };
  }
  return {
    ...(code !== undefined ? { code } : {}),
    message: rawMessage ?? httpErrorMessage(body, status, statusText),
    ...(typeof structured?.hint === "string" ? { hint: structured.hint } : {}),
    ...(typeof structured?.recoverable === "boolean" ? { recoverable: structured.recoverable } : {}),
    ...(structured?.context !== undefined ? { context: structured.context } : {}),
  };
}

function toVtxResponse(action: string, id: string, body: unknown): VtxResponse {
  return {
    ...(isRecord(body) ? body : { result: body }),
    action,
    id,
  } as VtxResponse;
}

/**
 * CLI 是最外层：hub → HTTP waiter → 这里，每层各加一档，少一档就抢在内层归因之前。
 */
export function cliAbortMsFor(action: string, callerTimeoutMs?: number): number {
  return transportTimeoutFor(transportTimeoutFor(hubDeadlineFor(action, callerTimeoutMs)));
}

/**
 * Sends one action over the Hub HTTP API and returns the existing CLI response shape.
 */
export async function sendRequest(
  action: string,
  params: Record<string, unknown>,
  opts: ClientOptions,
): Promise<VtxResponse> {
  const { namespace, method } = splitAction(action);
  const id = nextRequestId();
  const abortMs = cliAbortMsFor(action, params.timeout as number | undefined);
  const response = await fetch(`${resolveBaseUrl(opts)}/api/${namespace}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vortex-session": resolveSessionName(opts.session),
      ...(opts.tabId != null ? { "x-vortex-tab": String(opts.tabId) } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(abortMs),
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(formatCliError(cliErrorPayload(body, response.status, response.statusText)));
  }
  return toVtxResponse(action, id, body);
}

/**
 * Subscribes over WebSocket after completing the CLI hello and welcome handshake.
 */
export function subscribe(
  action: string,
  params: Record<string, unknown>,
  opts: ClientOptions & {
    onEvent: (event: VtxEvent) => void;
    onDisconnect?: (reason: string) => void;
  },
): Promise<VtxResponse> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId();
    const session = resolveSessionName(opts.session);
    const ws = new WebSocket(resolveWebSocketUrl(opts));
    let failed = false;
    let responseResolved = false;
    let requestSent = false;
    let disconnectReason = "connection closed by vortex-server";

    let timeout: ReturnType<typeof setTimeout>;

    const fail = (error: Error): void => {
      if (failed || responseResolved) return;
      failed = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    timeout = setTimeout(() => {
      fail(new Error(`Timeout: no response for ${action}`));
    }, 30_000);

    ws.on("open", () => {
      if (failed) return;
      try {
        ws.send(JSON.stringify({
          type: "hello",
          wireVersion: VTX_WIRE_VERSION,
          role: "cli",
          sessionId: session,
          label: session,
        }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.on("message", (data) => {
      if (failed) return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        fail(new Error("Invalid WebSocket message"));
        return;
      }
      if (!isRecord(message)) return;

      if (message.type === "welcome" && !requestSent) {
        requestSent = true;
        const request: VtxRequest = {
          type: "request",
          action,
          params,
          id,
          ...(opts.tabId != null ? { tabId: opts.tabId } : {}),
        };
        try {
          ws.send(JSON.stringify(request));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }

      if (typeof message.notice === "string") {
        disconnectReason = typeof message.reason === "string"
          ? `${message.notice}: ${message.reason}`
          : message.notice;
        return;
      }

      if (requestSent && typeof message.event === "string") {
        opts.onEvent(message as unknown as VtxEvent);
        return;
      }

      if (requestSent && message.id === id) {
        responseResolved = true;
        clearTimeout(timeout);
        resolve(message as unknown as VtxResponse);
      }
    });

    ws.on("error", (error) => {
      fail(new Error(`Connection failed: ${error.message}. Is vortex-server running?`));
    });

    ws.on("close", () => {
      // 响应已回过后 fail() 是空操作，--follow 会静默吊死；必须另有出口告知调用方
      if (responseResolved) {
        opts.onDisconnect?.(disconnectReason);
        return;
      }
      fail(new Error("Connection closed before response"));
    });
  });
}
