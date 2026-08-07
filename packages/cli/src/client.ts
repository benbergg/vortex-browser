/**
 * Author: qingwa
 * Description: Provides HTTP action requests and WebSocket subscriptions for the CLI.
 */
import WebSocket from "ws";
import {
  VTX_WIRE_VERSION,
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

function toVtxResponse(action: string, id: string, body: unknown): VtxResponse {
  return {
    ...(isRecord(body) ? body : { result: body }),
    action,
    id,
  } as VtxResponse;
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
  const response = await fetch(`${resolveBaseUrl(opts)}/api/${namespace}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vortex-session": resolveSessionName(opts.session),
      ...(opts.tabId != null ? { "x-vortex-tab": String(opts.tabId) } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(35_000),
  });
  const body = await parseResponseBody(response);
  if (!response.ok) throw new Error(httpErrorMessage(body, response.status, response.statusText));
  return toVtxResponse(action, id, body);
}

/**
 * Subscribes over WebSocket after completing the CLI hello and welcome handshake.
 */
export function subscribe(
  action: string,
  params: Record<string, unknown>,
  opts: ClientOptions & { onEvent: (event: VtxEvent) => void },
): Promise<VtxResponse> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId();
    const session = resolveSessionName(opts.session);
    const ws = new WebSocket(resolveWebSocketUrl(opts));
    let settled = false;
    let requestSent = false;

    let timeout: ReturnType<typeof setTimeout>;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    timeout = setTimeout(() => {
      fail(new Error(`Timeout: no response for ${action}`));
    }, 30_000);

    ws.on("open", () => {
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

      if (requestSent && typeof message.event === "string") {
        opts.onEvent(message as unknown as VtxEvent);
        return;
      }

      if (requestSent && message.id === id) {
        settled = true;
        clearTimeout(timeout);
        resolve(message as unknown as VtxResponse);
      }
    });

    ws.on("error", (error) => {
      fail(new Error(`Connection failed: ${error.message}. Is vortex-server running?`));
    });

    ws.on("close", () => {
      fail(new Error("Connection closed before response"));
    });
  });
}
