/**
 * Author: qingwa
 * Description: Verifies browser-targeted hub HTTP command routes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VtxErrorCode,
  type VtxAgentCommand,
  type VtxAgentResult,
  type VtxRequest,
  type VtxResponse,
} from "@vortex-browser/shared";
import {
  connectFakeAgent,
  startTestHub,
  type FakeAgent,
} from "./helpers/harness.js";
import { HubRouter } from "../src/router.js";

const agents: FakeAgent[] = [];

describe("hub HTTP command routes", () => {
  let started: Awaited<ReturnType<typeof startTestHub>> | undefined;

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.close()));
    await started?.close();
    started = undefined;
  });

  it("proxies a POST API request through a virtual session", async () => {
    const handleRequest = vi.spyOn(HubRouter.prototype, "handleRequest");
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const requests: VtxRequest[] = [];
    const agent = await addAgent(started, "browser-api");
    agent.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Partial<VtxRequest> & { type?: string };
      if (message.type === "request") requests.push(message as VtxRequest);
    });

    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: [{ id: 1, url: "about:blank", title: "Blank", active: true }],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        action: "tab.list",
        params: {},
        sessionId: `cli-${process.env.USER ?? "default"}`,
      });
      expect(handleRequest).toHaveBeenCalledWith(
        `cli-${process.env.USER ?? "default"}`,
        expect.objectContaining({ action: "tab.list", id: expect.stringMatching(/^http-\d+$/) }),
      );
    } finally {
      handleRequest.mockRestore();
    }
  });

  it("sweeps idle virtual sessions before creating the current session", async () => {
    let now = 1_000;
    started = await startTestHub({ now: () => now, virtualSessionIdleMs: 100, requestTimeoutMs: 1_000 });
    const stale = started.hub.getOrCreateVirtualSession("stale");
    stale.lastSeenAt = 0;
    await addAgent(started, "browser-sweep");

    const response = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: { "x-vortex-session": "fresh" },
    });

    expect(response.status).toBe(200);
    expect(started.hub.sessions.get("stale")).toBeUndefined();
    expect(started.hub.sessions.get("fresh")).toBeDefined();
  });

  it("keeps different session headers independent", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const requests: VtxRequest[] = [];
    const agent = await addAgent(started, "browser-sessions");
    agent.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Partial<VtxRequest> & { type?: string };
      if (message.type === "request") requests.push(message as VtxRequest);
    });

    const makeRequest = (sessionId: string) => fetch(`http://127.0.0.1:${started!.port}/api/tab/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vortex-session": sessionId,
      },
      body: JSON.stringify({}),
    });
    const [aliceResponse, bobResponse] = await Promise.all([
      makeRequest("alice"),
      makeRequest("bob"),
    ]);

    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);
    expect(started.hub.sessions.get("alice")).toBeDefined();
    expect(started.hub.sessions.get("bob")).toBeDefined();
    expect(started.hub.sessions.get("alice")).not.toBe(started.hub.sessions.get("bob"));
    expect(new Set(requests.map((request) => request.sessionId))).toEqual(new Set(["alice", "bob"]));
  });

  it("preserves the current tab for later requests in the same session", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const requests: VtxRequest[] = [];
    await addAgent(started, {
      browserId: "browser-state",
      handle: (request) => {
        requests.push(request);
        if (request.action === "tab.create") {
          return {
            action: request.action,
            id: request.id,
            result: { id: 2, url: "about:blank", title: "Created", active: true },
          };
        }
        return {
          action: request.action,
          id: request.id,
          result: { tabId: request.tabId },
        };
      },
    });

    const headers = {
      "content-type": "application/json",
      "x-vortex-session": "stateful",
    };
    const createResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://example.test" }),
    });
    const infoResponse = await fetch(`http://127.0.0.1:${started.port}/api/page/info`, {
      method: "POST",
      headers,
      body: JSON.stringify({ detail: true }),
    });

    expect(createResponse.status).toBe(200);
    expect(infoResponse.status).toBe(200);
    await expect(infoResponse.json()).resolves.toEqual({ result: { tabId: 2 } });
    expect(requests.find((request) => request.action === "page.info")).toMatchObject({
      tabId: 2,
      params: { detail: true },
    });
  });

  it("uses a body tabId before the header and removes it from params", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    let forwarded: VtxRequest | undefined;
    await addAgent(started, {
      browserId: "browser-tab-id",
      handle: (request) => {
        forwarded = request;
        return { action: request.action, id: request.id, result: { ok: true } };
      },
    });

    const response = await fetch(`http://127.0.0.1:${started.port}/api/test/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vortex-tab": "abc",
      },
      body: JSON.stringify({ tabId: 7, value: "kept" }),
    });

    expect(response.status).toBe(200);
    expect(forwarded).toMatchObject({ action: "test.run", tabId: 7, params: { value: "kept" } });
    expect(forwarded?.params).not.toHaveProperty("tabId");
  });

  it("rejects a nonnumeric tab header before submitting a request", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const requests: VtxRequest[] = [];
    const agent = await addAgent(started, "browser-invalid-tab");
    agent.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Partial<VtxRequest> & { type?: string };
      if (message.type === "request") requests.push(message as VtxRequest);
    });

    const response = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: { "x-vortex-tab": "abc" },
    });
    const body = await response.json() as { message?: string; error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ message: "tabId must be an integer", error: { code: VtxErrorCode.INVALID_PARAMS } });
    expect(requests).toEqual([]);
  });

  it("pins API requests to the browser selected by the header", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const requestsA: VtxRequest[] = [];
    const requestsB: VtxRequest[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    for (const [agent, requests] of [[first, requestsA], [second, requestsB]] as const) {
      agent.ws.on("message", (payload) => {
        const message = JSON.parse(payload.toString()) as Partial<VtxRequest> & { type?: string };
        if (message.type === "request") requests.push(message as VtxRequest);
      });
    }

    const response = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: { "x-vortex-browser": "browser-b", "x-vortex-session": "pinned" },
    });

    expect(response.status).toBe(200);
    expect(requestsA).toEqual([]);
    expect(requestsB).toHaveLength(1);
    expect(started.hub.sessions.get("pinned")).toMatchObject({
      browserId: "browser-b",
      pinned: true,
    });
  });

  it("rebinds an existing named session and clears ownership when its browser changes", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    await addAgent(started, "browser-a");
    await addAgent(started, "browser-b");
    const headersFor = (browserId: string) => ({
      "content-type": "application/json",
      "x-vortex-browser": browserId,
      "x-vortex-session": "switchable",
    });

    const createResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/create`, {
      method: "POST",
      headers: headersFor("browser-a"),
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(200);

    const firstSession = started.hub.sessions.get("switchable");
    expect(firstSession).toMatchObject({ browserId: "browser-a", currentTabId: 2 });
    expect(started.hub.browsers.get("browser-a")?.sessions.has("switchable")).toBe(true);
    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(2)).toBe("switchable");
    expect(firstSession?.ownedTabs).toEqual(new Set([2]));

    const listResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: headersFor("browser-b"),
      body: JSON.stringify({}),
    });
    expect(listResponse.status).toBe(200);

    const session = started.hub.sessions.get("switchable");
    expect(session).toMatchObject({ browserId: "browser-b", lastBrowserId: "browser-b", currentTabId: null });
    expect(session?.ownedTabs).toEqual(new Set());
    expect(started.hub.browsers.get("browser-a")?.sessions.has("switchable")).toBe(false);
    expect(started.hub.browsers.get("browser-a")?.tabOwner.has(2)).toBe(false);
    expect(started.hub.browsers.get("browser-b")?.sessions.has("switchable")).toBe(true);
  });

  it("clears the old binding when a preferred target browser is offline", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    await addAgent(started, "browser-a");
    const headersFor = (browserId: string) => ({
      "content-type": "application/json",
      "x-vortex-browser": browserId,
      "x-vortex-session": "offline-switch",
    });

    const createResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/create`, {
      method: "POST",
      headers: headersFor("browser-a"),
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(200);

    const response = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: headersFor("browser-offline"),
      body: JSON.stringify({}),
    });
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe(VtxErrorCode.EXTENSION_NOT_CONNECTED);
    expect(started.hub.browsers.get("browser-a")?.sessions.has("offline-switch")).toBe(false);
    expect(started.hub.browsers.get("browser-a")?.tabOwner.has(2)).toBe(false);
    expect(started.hub.browsers.get("browser-offline")).toBeUndefined();
    expect(started.hub.sessions.get("offline-switch")).toMatchObject({
      browserId: "browser-offline",
      lastBrowserId: "browser-offline",
      currentTabId: null,
      pinned: true,
    });
    expect(started.hub.sessions.get("offline-switch")?.ownedTabs).toEqual(new Set());
  });

  it("rebinds a pinned session when its offline target browser reconnects", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    await addAgent(started, "browser-a");
    const headersFor = (browserId: string) => ({
      "content-type": "application/json",
      "x-vortex-browser": browserId,
      "x-vortex-session": "reconnect-target",
    });

    const createResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/create`, {
      method: "POST",
      headers: headersFor("browser-a"),
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(200);

    const offlineResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: headersFor("browser-b"),
      body: JSON.stringify({}),
    });
    expect(offlineResponse.status).toBe(503);

    await addAgent(started, "browser-b");

    expect(started.hub.sessions.get("reconnect-target")).toMatchObject({
      browserId: "browser-b",
      lastBrowserId: "browser-b",
      pinned: true,
    });
    expect(started.hub.browsers.get("browser-a")?.sessions.has("reconnect-target")).toBe(false);
    expect(started.hub.browsers.get("browser-b")?.sessions.has("reconnect-target")).toBe(true);
  });

  it("does not restore stale lost-browser ownership after a pinned rebind", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    await addAgent(started, "browser-a");
    const browserB = await addAgent(started, "browser-b");
    const headersFor = (browserId: string) => ({
      "content-type": "application/json",
      "x-vortex-browser": browserId,
      "x-vortex-session": "lost-rebind",
    });

    const createResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/create`, {
      method: "POST",
      headers: headersFor("browser-b"),
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(200);
    await browserB.close();

    const moveToA = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: headersFor("browser-a"),
      body: JSON.stringify({}),
    });
    expect(moveToA.status).toBe(200);
    const moveToOfflineB = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: headersFor("browser-b"),
      body: JSON.stringify({}),
    });
    expect(moveToOfflineB.status).toBe(503);

    await addAgent(started, "browser-b");

    const session = started.hub.sessions.get("lost-rebind");
    expect(started.hub.browsers.get("browser-a")?.sessions.has("lost-rebind")).toBe(false);
    expect(started.hub.browsers.get("browser-b")?.sessions.has("lost-rebind")).toBe(true);
    expect(started.hub.browsers.get("browser-b")?.tabOwner.has(2)).toBe(false);
    expect(session).toMatchObject({ browserId: "browser-b", currentTabId: null });
    expect(session?.ownedTabs).toEqual(new Set());
  });

  it("terminates pending requests for a session when it rebinds", async () => {
    started = await startTestHub({ requestTimeoutMs: 2_000, virtualSessionRequestTimeoutMs: 2_000 });
    let resolveOldRequest: (() => void) | undefined;
    const browserA = await addAgent(started, {
      browserId: "browser-a",
      handle: (request) => new Promise<VtxResponse>((resolve) => {
        resolveOldRequest = () => resolve({ action: request.action, id: request.id, result: { late: true } });
      }),
    });
    await addAgent(started, "browser-b");
    const headersFor = (browserId: string) => ({
      "content-type": "application/json",
      "x-vortex-browser": browserId,
      "x-vortex-session": "pending-rebind",
    });

    const oldResponsePromise = fetch(`http://127.0.0.1:${started.port}/api/test/slow`, {
      method: "POST",
      headers: headersFor("browser-a"),
      body: JSON.stringify({ tabId: 1 }),
    });
    await browserA.waitFor((message): message is { type: "request"; action: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { action?: unknown }).action === "test.slow",
    );

    const rebindResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: headersFor("browser-b"),
      body: JSON.stringify({}),
    });

    expect(rebindResponse.status).toBe(200);
    expect(started.hub.pending.countBySession("pending-rebind")).toBe(0);
    expect((await oldResponsePromise).status).toBe(503);
    resolveOldRequest?.();
  });

  it("does not let a delayed old claim forward a request after rebind", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000, virtualSessionRequestTimeoutMs: 200 });
    const internalRequests: VtxRequest[] = [];
    let resolveInternal: (() => void) | undefined;
    const browserA = await addAgent(started, {
      browserId: "browser-a",
      handle: (request) => {
        if (request.action === "tab.list") {
          internalRequests.push(request);
          return new Promise<VtxResponse>((resolve) => {
            resolveInternal = () => resolve({
              action: request.action,
              id: request.id,
              result: [{ id: 1, url: "https://old.test", active: true }],
            });
          });
        }
        return { action: request.action, id: request.id, result: { accepted: true } };
      },
    });
    await addAgent(started, "browser-b");
    const headersFor = (browserId: string) => ({
      "content-type": "application/json",
      "x-vortex-browser": browserId,
      "x-vortex-session": "claim-rebind",
    });

    const oldResponsePromise = fetch(`http://127.0.0.1:${started.port}/api/page/info`, {
      method: "POST",
      headers: headersFor("browser-a"),
      body: JSON.stringify({}),
    });
    await browserA.waitFor((message): message is { type: "request"; action: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { action?: unknown }).action === "tab.list",
    );

    const rebindResponse = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: headersFor("browser-b"),
      body: JSON.stringify({}),
    });
    expect(rebindResponse.status).toBe(200);
    await oldResponsePromise;
    resolveInternal?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(internalRequests).toHaveLength(1);
    expect(browserA.messages.filter((message) =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { action?: unknown }).action === "page.info",
    )).toEqual([]);
    expect(started.hub.sessions.get("claim-rebind")).toMatchObject({
      browserId: "browser-b",
      currentTabId: null,
    });
    expect(started.hub.sessions.get("claim-rebind")?.ownedTabs).toEqual(new Set());
    expect(started.hub.browsers.get("browser-a")?.tabOwner.has(1)).toBe(false);
  });

  it("maps agent errors to the API status and body contract", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const errors: Record<string, VtxResponse["error"]> = {
      "test.tab-not-found": {
        code: VtxErrorCode.TAB_NOT_FOUND,
        message: "missing tab",
        recoverable: false,
      },
      "test.timeout": {
        code: VtxErrorCode.TIMEOUT,
        message: "agent timeout",
        recoverable: false,
      },
      "test.unmapped": {
        code: "UNMAPPED_CODE" as VtxErrorCode,
        message: "unmapped failure",
        recoverable: false,
      },
    };
    await addAgent(started, {
      browserId: "browser-errors",
      handle: (request) => ({ action: request.action, id: request.id, error: errors[request.action] }),
    });

    for (const [path, status, code, message] of [
      ["test/tab-not-found", 404, VtxErrorCode.TAB_NOT_FOUND, "missing tab"],
      ["test/timeout", 504, VtxErrorCode.TIMEOUT, "agent timeout"],
      ["test/unmapped", 502, "UNMAPPED_CODE", "unmapped failure"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/${path}`, {
        method: "POST",
        headers: { "x-vortex-tab": "1" },
      });
      const body = await response.json() as { message?: string; error?: { code?: string } };
      expect(response.status).toBe(status);
      expect(body).toMatchObject({ message, error: { code } });
    }
  });

  it("returns 504 and detaches the sink when the HTTP waiter times out", async () => {
    started = await startTestHub({ requestTimeoutMs: 500, virtualSessionRequestTimeoutMs: 20 });
    await addAgent(started, {
      browserId: "browser-timeout",
      handle: () => new Promise<VtxResponse>(() => {}),
    });

    const response = await fetch(`http://127.0.0.1:${started.port}/api/test/slow`, {
      method: "POST",
      headers: { "x-vortex-session": "timeout" },
    });
    const body = await response.json() as { message?: string; error?: { code?: string } };

    expect(response.status).toBe(504);
    expect(body.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(started.hub.sessions.get("timeout")?.sink).toBeUndefined();
  });

  it("routes concurrent same-session responses by request id despite ignored frames", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000, virtualSessionRequestTimeoutMs: 500 });
    const pending = new Map<string, { request: VtxRequest; resolve: (response: VtxResponse) => void }>();
    let resolveAllReceived: (() => void) | undefined;
    const allReceived = new Promise<void>((resolve) => {
      resolveAllReceived = resolve;
    });
    const handle = (request: VtxRequest) => new Promise<VtxResponse>((resolve) => {
      pending.set(request.id, { request, resolve });
      if (pending.size === 2) resolveAllReceived?.();
    });
    await addAgent(started, { browserId: "browser-concurrent", handle });

    const firstResponse = fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vortex-session": "concurrent" },
      body: JSON.stringify({ marker: "first" }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    const secondResponse = fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vortex-session": "concurrent" },
      body: JSON.stringify({ marker: "second" }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));

    await allReceived;
    const session = started.hub.sessions.get("concurrent");
    const sink = session?.sink;
    expect(sink).toBeDefined();
    sink?.({ type: "notice", notice: "browser-assigned" });
    sink?.({ type: "event", event: "noise", data: {}, timestamp: Date.now() });
    sink?.({ type: "response", id: "http-wrong", action: "tab.list", result: { marker: "wrong" } });
    expect(session?.sink).toBe(sink);

    const requests = [...pending.values()];
    requests[1].resolve({
      type: "response",
      action: requests[1].request.action,
      id: requests[1].request.id,
      result: { marker: requests[1].request.params?.marker },
    });
    requests[0].resolve({
      type: "response",
      action: requests[0].request.action,
      id: requests[0].request.id,
      result: { marker: requests[0].request.params?.marker },
    });

    const [first, second] = await Promise.all([firstResponse, secondResponse]);
    expect(first).toEqual({ status: 200, body: { result: { marker: "first" } } });
    expect(second).toEqual({ status: 200, body: { result: { marker: "second" } } });
    expect(session?.sink).toBeUndefined();
  });

  it("blocks relaunch with multiple browsers before sending a command", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/relaunch-trusted`, { method: "POST" });
    expect(response.status).toBe(409);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("多浏览器下无法按 profile 重启，这是已知限制");
    expect(commands).toEqual([]);
  });

  it("proxies relaunch for the only browser through the fake agent", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const commands: VtxAgentCommand[] = [];
    observeCommands(agent, commands);
    replyToCommands(agent, () => ({ result: true }));

    const response = await fetch(`http://127.0.0.1:${started.port}/relaunch-trusted`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("relaunch-trusted");
  });

  it("uses the only browser for trusted-mode when browserId is omitted", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const commands: VtxAgentCommand[] = [];
    observeCommands(agent, commands);
    replyToCommands(agent, () => ({ result: true }));

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ trustedMode: true });
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("trusted-mode");
  });

  it("requires browserId for trusted-mode with multiple browsers and lists choices", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(400);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("browser-a");
    expect(body.message).toContain("browser-b");
    expect(commands).toEqual([]);
  });

  it("targets the requested browser for trusted-mode", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);
    replyToCommands(first, () => ({ result: true }));
    replyToCommands(second, () => ({ result: false }));

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode?browserId=browser-b`);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ trustedMode: false });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "trusted-mode" });
  });

  it("rejects an unknown trusted-mode browser without sending a command", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const commands: VtxAgentCommand[] = [];
    observeCommands(agent, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode?browserId=missing`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("missing");
    expect(commands).toEqual([]);
  });

  it("passes a trusted-mode agent error through as a non-success response", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const error = {
      code: VtxErrorCode.PERMISSION_DENIED,
      message: "trusted mode is unavailable",
      recoverable: false,
      context: { extras: { source: "fake-agent" } },
    };
    replyToCommands(agent, () => ({ error }));

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(502);
    const body = await response.json();

    expect(body).toMatchObject({ message: error.message, error });
  });

  it("rejects an unspecified reload with multiple browsers", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("browserId");
    expect(commands).toEqual([]);
  });

  it("parses JSON and reloads the requested browser only", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const firstCommands: VtxAgentCommand[] = [];
    const secondCommands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, firstCommands);
    observeCommands(second, secondCommands);
    replyToCommands(first, () => ({ result: { reloaded: "a" } }));
    replyToCommands(second, () => ({ result: { reloaded: "b" } }));

    const response = await fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ browserId: "browser-b" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ ok: true });
    expect(firstCommands).toHaveLength(0);
    expect(secondCommands).toHaveLength(1);
    expect(secondCommands[0].command).toBe("reload-extension");
  });

  it("reloads all browsers concurrently and preserves each result or error", async () => {
    started = await startTestHub({ requestTimeoutMs: 500 });
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    const error = {
      code: VtxErrorCode.PERMISSION_DENIED,
      message: "reload denied",
      recoverable: false,
    };
    const { commands, allReceived } = replyToCommandsAfterAll(
      [first, second],
      [
        { result: { reloaded: "a" } },
        { error },
      ],
    );

    const request = fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    await expect(allReceived).resolves.toBeUndefined();
    const response = await request;
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok?: boolean;
      results?: Array<Record<string, unknown>>;
    };

    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      { browserId: "browser-a", ok: true, result: { reloaded: "a" } },
      { browserId: "browser-b", ok: false, error },
    ]);
    expect(commands).toHaveLength(2);
  });

  it("keeps successful all results when one agent command rejects", async () => {
    started = await startTestHub({ requestTimeoutMs: 500 });
    const firstCommands: VtxAgentCommand[] = [];
    const secondCommands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, firstCommands);
    observeCommands(second, secondCommands);
    let resolveSecondCommand: (() => void) | undefined;
    const secondCommandReceived = new Promise<void>((resolve) => {
      resolveSecondCommand = resolve;
    });
    first.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as unknown;
      if (!isAgentCommand(message)) return;
      first.ws.send(JSON.stringify({
        type: "agent-result",
        id: message.id,
        result: { reloaded: "a" },
      }));
    });
    second.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as unknown;
      if (!isAgentCommand(message)) return;
      resolveSecondCommand?.();
      second.ws.close();
    });

    const responsePromise = fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    await expect(secondCommandReceived).resolves.toBeUndefined();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok?: boolean;
      results?: Array<Record<string, unknown>>;
    };

    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      { browserId: "browser-a", ok: true, result: { reloaded: "a" } },
      {
        browserId: "browser-b",
        ok: false,
        error: {
          code: VtxErrorCode.INTERNAL_ERROR,
          message: "Browser agent disconnected",
          recoverable: false,
        },
      },
    ]);
    expect(firstCommands).toHaveLength(1);
    expect(secondCommands).toHaveLength(1);
    await second.closed;
  });

  it("returns a clear error without sending a command when no browser is available", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(503);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("没有可用 browser");
  });
});

type StartedHub = Awaited<ReturnType<typeof startTestHub>>;

async function addAgent(
  hub: StartedHub,
  browserOrOptions: string | Parameters<typeof connectFakeAgent>[1],
): Promise<FakeAgent> {
  const options = typeof browserOrOptions === "string"
    ? { browserId: browserOrOptions }
    : browserOrOptions;
  const agent = await connectFakeAgent(hub.port, options);
  agents.push(agent);
  return agent;
}

function observeCommands(agent: FakeAgent, commands: VtxAgentCommand[]): void {
  agent.ws.on("message", (payload) => {
    const message = JSON.parse(payload.toString()) as unknown;
    if (isAgentCommand(message)) commands.push(message);
  });
}

function replyToCommands(
  agent: FakeAgent,
  makeReply: (command: VtxAgentCommand) => Omit<VtxAgentResult, "type" | "id">,
): void {
  agent.ws.on("message", (payload) => {
    const message = JSON.parse(payload.toString()) as unknown;
    if (!isAgentCommand(message)) return;
    agent.ws.send(JSON.stringify({ type: "agent-result", id: message.id, ...makeReply(message) }));
  });
}

function replyToCommandsAfterAll(
  agents: FakeAgent[],
  replies: Array<Omit<VtxAgentResult, "type" | "id">>,
): { commands: VtxAgentCommand[]; allReceived: Promise<void> } {
  const commands: VtxAgentCommand[] = [];
  let resolveAll: (() => void) | undefined;
  const allReceived = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const receivedAgents = new Set<FakeAgent>();
  agents.forEach((agent, index) => {
    agent.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as unknown;
      if (!isAgentCommand(message)) return;
      commands.push(message);
      receivedAgents.add(agent);
      if (receivedAgents.size === agents.length) resolveAll?.();
      void allReceived.then(() => {
        agent.ws.send(JSON.stringify({ type: "agent-result", id: message.id, ...replies[index] }));
      });
    });
  });
  return { commands, allReceived };
}

function isAgentCommand(message: unknown): message is VtxAgentCommand {
  if (!message || typeof message !== "object") return false;
  const frame = message as Partial<VtxAgentCommand>;
  return frame.type === "agent-command" && typeof frame.id === "string" && typeof frame.command === "string";
}
