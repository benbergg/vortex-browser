/**
 * Author: qingwa
 * Description: Verifies expanded health data and graceful hub shutdown.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { VtxResponse } from "@vortex-browser/shared";
import {
  connectClient,
  connectFakeAgent,
  startTestHub,
  type FakeAgent,
  type TestClient,
} from "./helpers/harness.js";

describe("hub health and shutdown", () => {
  let started: Awaited<ReturnType<typeof startTestHub>> | undefined;
  const clients: TestClient[] = [];
  const agents: FakeAgent[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(agents.splice(0).map((agent) => agent.close()));
    await started?.close();
    started = undefined;
  });

  it("returns an empty healthy snapshot when no browser is registered", async () => {
    started = await startTestHub();

    const response = await fetch(`http://127.0.0.1:${started.port}/health`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      hubVersion: "1.0.0",
      nmConnected: false,
      browsers: [],
      sessions: [],
    });
    expect(body.timestamp).toEqual(expect.any(Number));
  });

  it("reports every browser metadata field and session assignment", async () => {
    started = await startTestHub();
    agents.push(await connectFakeAgent(started.port, {
      browserId: "browser-a",
      hello: {
        label: "Chrome A",
        peerVersion: "agent-a",
        extensionVersion: "extension-a",
        buildStamp: "build-a",
        extDist: "/dist/a",
      },
    }));
    agents.push(await connectFakeAgent(started.port, {
      browserId: "browser-b",
      hello: {
        label: "Chrome B",
        peerVersion: "agent-b",
        extensionVersion: "extension-b",
        buildStamp: "build-b",
        extDist: "/dist/b",
      },
    }));
    agents.push(await connectFakeAgent(started.port, { browserId: "browser-c" }));
    clients.push(await connectClient(started.port, { sessionId: "session-a", label: "Client A" }));
    clients.push(await connectClient(started.port, { sessionId: "session-b", label: "Client B" }));
    await clients[0].request({ action: "page.navigate", params: { url: "https://a.test" }, id: "navigate-a" });
    await clients[1].request({ action: "page.navigate", params: { url: "https://b.test" }, id: "navigate-b" });

    agents[0].ws.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now(), nmConnected: false }));
    await waitForCondition(() => started?.hub.browsers.get("browser-a")?.nmConnected === false);

    const response = await fetch(`http://127.0.0.1:${started.port}/health`);
    const body = await response.json() as {
      nmConnected: boolean;
      browsers: Array<Record<string, unknown>>;
      sessions: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.nmConnected).toBe(true);
    expect(body.browsers).toEqual(expect.arrayContaining([
      {
        browserId: "browser-a",
        label: "Chrome A",
        nmConnected: false,
        extensionVersion: "extension-a",
        buildStamp: "build-a",
        extDist: "/dist/a",
        sessions: ["session-a"],
      },
      {
        browserId: "browser-b",
        label: "Chrome B",
        nmConnected: true,
        extensionVersion: "extension-b",
        buildStamp: "build-b",
        extDist: "/dist/b",
        sessions: ["session-b"],
      },
      {
        browserId: "browser-c",
        label: "browser-c",
        nmConnected: true,
        extensionVersion: null,
        buildStamp: null,
        extDist: null,
        sessions: [],
      },
    ]));
    expect(body.browsers).toHaveLength(3);
    expect(body.sessions).toEqual(expect.arrayContaining([
      {
        sessionId: "session-a",
        role: "mcp",
        label: "Client A",
        browserId: "browser-a",
        currentTabId: 1,
      },
      {
        sessionId: "session-b",
        role: "mcp",
        label: "Client B",
        browserId: "browser-b",
        currentTabId: 1,
      },
    ]));
    expect(body.sessions).toHaveLength(2);
  });

  it("broadcasts shutdown notice to every session and browser agent", async () => {
    started = await startTestHub();
    agents.push(await connectFakeAgent(started.port, { browserId: "browser-a" }));
    agents.push(await connectFakeAgent(started.port, { browserId: "browser-b" }));
    clients.push(await connectClient(started.port, { sessionId: "session-a" }));
    clients.push(await connectClient(started.port, { sessionId: "session-b" }));

    await expect(postShutdown(started.port)).resolves.toEqual({ ok: true });
    const isShutdown = (message: unknown): message is { type: "notice"; notice: "hub-shutdown" } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "notice" &&
      (message as { notice?: unknown }).notice === "hub-shutdown";
    await Promise.all([
      ...clients.map((client) => client.waitFor(isShutdown)),
      ...agents.map((agent) => agent.waitFor(isShutdown)),
      started.hub.close(),
      started.hub.close(),
    ]);
  });

  it("drains a response before closing the connected peers", async () => {
    let resolveAgent: ((response: { action: string; id: string; result: unknown }) => void) | undefined;
    const agentResponse = new Promise<{ action: string; id: string; result: unknown }>((resolve) => {
      resolveAgent = resolve;
    });
    started = await startTestHub({ shutdownTimeoutMs: 1_000 });
    agents.push(await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: () => agentResponse,
    }));
    clients.push(await connectClient(started.port, { sessionId: "session-a" }));

    const request = clients[0].request({ action: "slow.action", id: "drain-1", tabId: 1 });
    await agents[0].waitFor((message): message is { type: "request"; id: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { id?: unknown }).id === "session-a#1",
    );
    expect(started.hub.pending.size).toBe(1);

    await expect(postShutdown(started.port)).resolves.toEqual({ ok: true });
    await waitForListenerClosed(started.port);
    expect(started.hub.pending.size).toBe(1);
    resolveAgent?.({ action: "slow.action", id: "session-a#1", result: { accepted: true } });

    await expect(request).resolves.toMatchObject({ id: "drain-1", result: { accepted: true } });
    await Promise.all([started.hub.close(), clients[0].closed, agents[0].closed]);
    expect(started.hub.pending.size).toBe(0);
    await expect(listenerRequest(started.port)).rejects.toThrow();
  });

  it("does not heal a late TAB_NOT_FOUND response after shutdown begins", async () => {
    let resolveAgent: ((response: VtxResponse) => void) | undefined;
    const agentResponse = new Promise<VtxResponse>((resolve) => {
      resolveAgent = resolve;
    });
    started = await startTestHub({ shutdownTimeoutMs: 100 });
    agents.push(await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request) => request.action === "tab.list"
        ? { action: request.action, id: request.id, result: [{ id: 1, url: "https://target.test", active: true }] }
        : agentResponse,
    }));
    clients.push(await connectClient(started.port, { sessionId: "session-a" }));

    const request = clients[0].request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      id: "late-tab-not-found",
    });
    await agents[0].waitFor((message): message is { type: "request"; action: string; id: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { action?: unknown }).action === "page.navigate" &&
      (message as { id?: unknown }).id === "session-a#1",
    );
    expect(started.hub.sessions.get("session-a")).toMatchObject({ currentTabId: 1 });
    expect(started.hub.sessions.get("session-a")?.ownedTabs.has(1)).toBe(true);

    await expect(postShutdown(started.port)).resolves.toEqual({ ok: true });
    await waitForListenerClosed(started.port);
    expect(started.hub.pending.size).toBe(1);
    resolveAgent?.({
      action: "page.navigate",
      id: "session-a#1",
      error: { code: "TAB_NOT_FOUND", message: "late response", recoverable: true },
    });

    await expect(request).resolves.toMatchObject({ id: "late-tab-not-found", error: { code: "TIMEOUT" } });
    expect(started.hub.sessions.get("session-a")).toMatchObject({ currentTabId: 1 });
    expect(started.hub.sessions.get("session-a")?.ownedTabs.has(1)).toBe(true);
    await Promise.all([started.hub.close(), clients[0].closed, agents[0].closed]);
  });

  it("finishes shutdown when an in-flight forward task rejects", async () => {
    started = await startTestHub({ shutdownTimeoutMs: 25 });
    agents.push(await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: () => new Promise(() => {}),
    }));
    clients.push(await connectClient(started.port, { sessionId: "session-a" }));
    clients.push(await connectClient(started.port, { sessionId: "session-b" }));
    const sessionWs = started.hub.sessions.get("session-a")?.ws;
    if (!sessionWs) throw new Error("Hub did not register session WebSocket");
    const originalSend = sessionWs.send.bind(sessionWs);
    sessionWs.send = ((payload: string) => {
      const message = JSON.parse(payload) as { type?: string };
      if (message.type === "response") throw new Error("synthetic session response failure");
      originalSend(payload);
    }) as typeof sessionWs.send;
    clients[0].ws.send(JSON.stringify({
      type: "request",
      action: "page.navigate",
      params: { url: "https://rejecting.test" },
      id: "rejecting-1",
    }));
    await agents[0].waitFor((message): message is { type: "request"; action: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { action?: unknown }).action === "tab.list",
    );
    const request = clients[1].request({ action: "held.action", id: "held-1", tabId: 1 });
    await waitForCondition(() => started?.hub.pending.size === 1);

    await expect(postShutdown(started.port)).resolves.toEqual({ ok: true });
    await expect(started.hub.close()).resolves.toBeUndefined();
    await expect(request).resolves.toMatchObject({ id: "held-1", error: { code: "TIMEOUT" } });
    expect(started.hub.pending.size).toBe(0);
    await Promise.all([clients[0].closed, clients[1].closed, agents[0].closed]);
    await expect(listenerRequest(started.port)).rejects.toThrow();
  });

  it("returns TIMEOUT when shutdown interrupts current-tab resolution before pending registration", async () => {
    started = await startTestHub({ shutdownTimeoutMs: 100 });
    agents.push(await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: () => new Promise(() => {}),
    }));
    clients.push(await connectClient(started.port, { sessionId: "session-a" }));

    const response = clients[0].waitFor((message): message is {
      type: "response";
      id: string;
      error: { code: string };
    } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "response" &&
      (message as { id?: unknown }).id === "internal-timeout-1" &&
      typeof (message as { error?: unknown }).error === "object" &&
      (message as { error?: { code?: unknown } }).error?.code === "TIMEOUT",
      250,
    );
    void clients[0].request({
      action: "page.navigate",
      params: { url: "https://shutdown.test" },
      id: "internal-timeout-1",
    });
    await agents[0].waitFor((message): message is { type: "request"; action: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { action?: unknown }).action === "tab.list",
    );
    expect(started.hub.pending.size).toBe(0);

    await expect(postShutdown(started.port)).resolves.toEqual({ ok: true });
    await expect(response).resolves.toMatchObject({
      type: "response",
      id: "internal-timeout-1",
      error: { code: "TIMEOUT" },
    });
    await Promise.all([started.hub.close(), clients[0].closed, agents[0].closed]);
    expect(started.hub.pending.size).toBe(0);
  });

  it("fails an unanswered pending request with TIMEOUT before closing listener and peers", async () => {
    started = await startTestHub({ shutdownTimeoutMs: 25 });
    agents.push(await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: () => new Promise(() => {}),
    }));
    clients.push(await connectClient(started.port, { sessionId: "session-a" }));

    const request = clients[0].request({ action: "slow.action", id: "timeout-1", tabId: 1 });
    await agents[0].waitFor((message): message is { type: "request"; id: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { id?: unknown }).id === "session-a#1",
    );

    await expect(postShutdown(started.port)).resolves.toEqual({ ok: true });
    await expect(request).resolves.toMatchObject({ id: "timeout-1", error: { code: "TIMEOUT" } });
    await Promise.all([started.hub.close(), clients[0].closed, agents[0].closed]);
    expect(started.hub.pending.size).toBe(0);
    await expect(listenerRequest(started.port)).rejects.toThrow();
  });
});

async function postShutdown(port: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/hub/shutdown`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json();
}

function listenerRequest(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/health`);
}

async function waitForListenerClosed(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await listenerRequest(port);
      await response.arrayBuffer();
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Hub listener still accepts connections");
}

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for hub state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
