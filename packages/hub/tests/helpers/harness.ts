/**
 * Author: qingwa
 * Description: Real WebSocket harness for hub runtime tests.
 */
import WebSocket from "ws";
import type {
  VtxEvent,
  VtxHello,
  VtxNotice,
  VtxRequest,
  VtxResponse,
  VtxWelcome,
} from "@vortex-browser/shared";
import { createHub, type HubHandle, type HubOptions } from "../../src/hub.js";

export interface RawTab {
  id: number;
  url: string;
  title: string;
  active?: boolean;
  windowId?: number;
  lastFocused?: boolean;
}

export interface TestClient {
  readonly ws: WebSocket;
  readonly welcome: VtxWelcome;
  readonly messages: unknown[];
  readonly responses: VtxResponse[];
  readonly events: VtxEvent[];
  readonly notices: VtxNotice[];
  readonly closed: Promise<{ code: number; reason: string }>;
  request(request: Omit<VtxRequest, "type" | "sessionId" | "browserId">): Promise<VtxResponse>;
  waitFor<T>(predicate: (message: unknown) => message is T, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export interface FakeAgent {
  readonly ws: WebSocket;
  readonly welcome: VtxWelcome;
  readonly tabs: RawTab[];
  readonly messages: unknown[];
  readonly closed: Promise<{ code: number; reason: string }>;
  emit(event: Omit<VtxEvent, "type" | "timestamp" | "browserId">): void;
  close(): Promise<void>;
}

export async function startTestHub(opts: Partial<HubOptions> = {}): Promise<{
  port: number;
  hub: HubHandle;
  close(): Promise<void>;
}> {
  const hub = await createHub({ ...opts, port: 0 });
  return { port: hub.port, hub, close: () => hub.close() };
}

export async function connectClient(port: number, hello: Partial<VtxHello>): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return connectPeer(ws, {
    type: "hello",
    wireVersion: 2,
    role: "mcp",
    sessionId: hello.sessionId ?? `session-${Date.now()}`,
    ...hello,
  });
}

export async function connectFakeAgent(
  port: number,
  opts: {
    browserId: string;
    tabs?: RawTab[];
    handle?: (req: VtxRequest) => VtxResponse | Promise<VtxResponse>;
  },
): Promise<FakeAgent> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: unknown[] = [];
  const tabs = opts.tabs ?? [{ id: 1, url: "about:blank", title: "Blank", active: true }];
  const closed = closePromise(ws);
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    messages.push(message);
    if (message.type !== "request") return;
    const request = message as unknown as VtxRequest;
    void respondToRequest(ws, request, tabs, opts.handle);
  });

  const welcome = await waitForWelcome(ws, {
    type: "hello",
    wireVersion: 2,
    role: "browser-agent",
    browserId: opts.browserId,
  });

  return {
    ws,
    welcome,
    tabs,
    messages,
    closed,
    emit(event) {
      ws.send(JSON.stringify({ ...event, type: "event", timestamp: Date.now() }));
    },
    close: () => closeWebSocket(ws),
  };
}

async function respondToRequest(
  ws: WebSocket,
  request: VtxRequest,
  tabs: RawTab[],
  customHandler?: (req: VtxRequest) => VtxResponse | Promise<VtxResponse>,
): Promise<void> {
  const response = customHandler
    ? await customHandler(request)
    : defaultResponse(request, tabs);
  ws.send(JSON.stringify({ ...response, type: "response", id: request.id, action: request.action }));
}

function defaultResponse(request: VtxRequest, tabs: RawTab[]): VtxResponse {
  if (request.action === "tab.list") return { action: request.action, id: request.id, result: tabs.slice() };
  if (request.action === "tab.create") {
    const id = Math.max(0, ...tabs.map((tab) => tab.id)) + 1;
    const tab = { id, url: "about:blank", title: "New tab", active: true };
    tabs.push(tab);
    return { action: request.action, id: request.id, result: tab };
  }
  if (request.action === "tab.close") {
    const tabId = Number(request.params?.tabId ?? request.tabId);
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index >= 0) tabs.splice(index, 1);
    return { action: request.action, id: request.id, result: { closed: index >= 0 } };
  }
  return { action: request.action, id: request.id, result: { echo: request.params ?? null } };
}

async function connectPeer(ws: WebSocket, hello: VtxHello): Promise<TestClient> {
  const messages: unknown[] = [];
  const responses: VtxResponse[] = [];
  const events: VtxEvent[] = [];
  const notices: VtxNotice[] = [];
  const closed = closePromise(ws);
  const waiters: Array<{
    predicate: (message: unknown) => boolean;
    resolve: (message: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    messages.push(message);
    if (message.type === "response") responses.push(message as unknown as VtxResponse);
    if (message.type === "event") events.push(message as unknown as VtxEvent);
    if (message.type === "notice") notices.push(message as unknown as VtxNotice);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });

  const welcome = await waitForWelcome(ws, hello);
  return {
    ws,
    welcome,
    messages,
    responses,
    events,
    notices,
    closed,
    request(request) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${request.id}`)), 60_000);
        waiters.push({
          predicate: (message) =>
            typeof message === "object" && message !== null &&
            (message as { type?: unknown }).type === "response" &&
            (message as { id?: unknown }).id === request.id,
          resolve: (message) => resolve(message as VtxResponse),
          reject,
          timer,
        });
        ws.send(JSON.stringify({ ...request, type: "request" }));
      });
    },
    waitFor<T>(predicate: (message: unknown) => message is T, timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const existing = messages.find(predicate);
        if (existing !== undefined) {
          resolve(existing as T);
          return;
        }
        const timer = setTimeout(() => reject(new Error("Timed out waiting for hub message")), timeoutMs);
        waiters.push({ predicate, resolve: (message) => resolve(message as T), reject, timer });
      });
    },
    close: () => closeWebSocket(ws),
  };
}

async function waitForWelcome(ws: WebSocket, hello: VtxHello): Promise<VtxWelcome> {
  await waitForOpen(ws);
  ws.send(JSON.stringify(hello));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for welcome")), 2_000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      const message = JSON.parse(data.toString()) as VtxWelcome;
      if (message.type !== "welcome") {
        reject(new Error(`Expected welcome, received ${message.type ?? "unknown"}`));
        return;
      }
      resolve(message);
    });
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function closePromise(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}
