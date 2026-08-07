/**
 * Author: qingwa
 * Description: Verifies CLI HTTP requests and the WebSocket subscription handshake.
 */
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { readFileSync } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { VTX_WIRE_VERSION } from "@vortex-browser/shared";
import { sendRequest, subscribe } from "../src/client.js";

let httpServer: Server | undefined;

afterEach(async () => {
  if (!httpServer) return;
  await new Promise<void>((resolve, reject) => {
    httpServer!.close((error) => error ? reject(error) : resolve());
  });
  httpServer = undefined;
});

async function startHttpServer(
  handler: RequestListener,
): Promise<string> {
  httpServer = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for WebSocket frame");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("sendRequest", () => {
  it("rejects an action without a usable namespace separator before fetching", async () => {
    await expect(
      sendRequest("tablist", {}, { port: 0, baseUrl: "not-a-url" }),
    ).rejects.toThrow("expected <namespace>.<method>");
  });

  it("posts the action, headers, and params to an injected HTTP server", async () => {
    let requestMethod: string | undefined;
    let requestUrl: string | undefined;
    let requestHeaders: Record<string, string | string[] | undefined> | undefined;
    let requestBody: string | undefined;
    const baseUrl = await startHttpServer(async (request, response) => {
      requestMethod = request.method;
      requestUrl = request.url;
      requestHeaders = request.headers;
      requestBody = await readRequestBody(request);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ result: { ok: true } }));
    });

    const result = await sendRequest(
      "page.navigate",
      { url: "https://example.test", active: true },
      { port: 0, baseUrl: `${baseUrl}/`, session: "session-a", tabId: 42 },
    );

    expect(requestMethod).toBe("POST");
    expect(requestUrl).toBe("/api/page/navigate");
    expect(requestHeaders?.["content-type"]).toContain("application/json");
    expect(requestHeaders?.["x-vortex-session"]).toBe("session-a");
    expect(requestHeaders?.["x-vortex-tab"]).toBe("42");
    expect(JSON.parse(requestBody!)).toEqual({ url: "https://example.test", active: true });
    expect(result).toMatchObject({ action: "page.navigate", result: { ok: true } });
    expect(result.id).toEqual(expect.any(String));
  });

  it("preserves the exact message from a non-2xx JSON response", async () => {
    const message = "exact server message";
    const baseUrl = await startHttpServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message }));
    });

    const error = await sendRequest("tab.missing", {}, { port: 0, baseUrl }).catch((value) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  });
});

describe("client transport boundaries", () => {
  it("keeps WebSocket references out of the sendRequest function body", () => {
    const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function sendRequest");
    const signatureEnd = source.indexOf("): Promise<VtxResponse> {", start);
    const openBrace = source.indexOf("{", signatureEnd);
    let depth = 0;
    let end = -1;
    for (let index = openBrace; index < source.length; index++) {
      if (source[index] === "{") depth++;
      if (source[index] === "}") {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }

    expect(start).toBeGreaterThanOrEqual(0);
    expect(signatureEnd).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(openBrace);
    expect(source.slice(openBrace, end + 1)).not.toContain("WebSocket");
  });

  it("sends hello first and waits for welcome before sending the request", async () => {
    const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" });
    let clientSocket: WebSocket | undefined;
    const frames: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve, reject) => {
      socketServer.once("listening", () => resolve());
      socketServer.once("error", reject);
    });
    socketServer.on("connection", (socket) => {
      clientSocket = socket;
      socket.on("message", (payload) => frames.push(JSON.parse(payload.toString())));
    });

    const address = socketServer.address();
    if (!address || typeof address === "string") throw new Error("WebSocket server did not expose a TCP address");

    try {
      const responsePromise = subscribe("console.subscribe", {}, {
        port: 0,
        baseUrl: `http://127.0.0.1:${address.port}`,
        session: "session-b",
        tabId: 9,
        onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
      });

      await waitFor(() => frames.length === 1);
      expect(frames[0]).toEqual({
        type: "hello",
        wireVersion: VTX_WIRE_VERSION,
        role: "cli",
        sessionId: "session-b",
        label: "session-b",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frames).toHaveLength(1);

      clientSocket!.send(JSON.stringify({
        type: "welcome",
        wireVersion: VTX_WIRE_VERSION,
        hubVersion: "test",
      }));
      await waitFor(() => frames.length === 2);
      expect(frames[1]).toMatchObject({
        type: "request",
        action: "console.subscribe",
        params: {},
        tabId: 9,
      });

      const requestId = frames[1].id;
      clientSocket!.send(JSON.stringify({
        type: "response",
        action: "console.subscribe",
        id: requestId,
        result: { subscribed: true },
      }));
      await expect(responsePromise).resolves.toMatchObject({
        action: "console.subscribe",
        result: { subscribed: true },
      });
      clientSocket!.send(JSON.stringify({
        type: "event",
        event: "console.message",
        data: { text: "after response" },
        timestamp: Date.now(),
      }));
      await waitFor(() => events.length === 1);
      expect(events[0]).toMatchObject({ event: "console.message", data: { text: "after response" } });
    } finally {
      clientSocket?.terminate();
      await new Promise<void>((resolve, reject) => {
        socketServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("closes and ignores late frames after a subscription error", async () => {
    const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" });
    let serverSocket: WebSocket | undefined;
    let helloReceived = false;
    const requests: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve, reject) => {
      socketServer.once("listening", () => resolve());
      socketServer.once("error", reject);
    });
    socketServer.on("connection", (socket) => {
      serverSocket = socket;
      socket.on("message", (payload) => {
        const frame = JSON.parse(payload.toString()) as Record<string, unknown>;
        if (frame.type === "hello") helloReceived = true;
        if (frame.type === "request") requests.push(frame);
      });
    });

    const address = socketServer.address();
    if (!address || typeof address === "string") throw new Error("WebSocket server did not expose a TCP address");

    try {
      const responsePromise = subscribe("console.subscribe", {}, {
        port: 0,
        baseUrl: `http://127.0.0.1:${address.port}`,
        session: "session-error",
        onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
      });

      await waitFor(() => helloReceived);
      serverSocket!.send("not-json");
      await expect(responsePromise).rejects.toThrow("Invalid WebSocket message");

      if (serverSocket!.readyState === WebSocket.OPEN) {
        serverSocket!.send(JSON.stringify({
          type: "welcome",
          wireVersion: VTX_WIRE_VERSION,
          hubVersion: "late",
        }));
        serverSocket!.send(JSON.stringify({
          type: "event",
          event: "console.message",
          data: { text: "late" },
          timestamp: Date.now(),
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(requests).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(serverSocket!.readyState);
    } finally {
      serverSocket?.terminate();
      await new Promise<void>((resolve, reject) => {
        socketServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
