/**
 * Author: qingwa
 * Description: Covers virtual hub session lifecycle and transport behavior.
 */
import { createHub } from "../src/hub.js";
import { VTX_WIRE_VERSION } from "@vortex-browser/shared";
import { SessionRegistry } from "../src/registry.js";
import { HubRouter } from "../src/router.js";
import {
  getOrCreateVirtualSession,
  sweepIdleVirtualSessions,
  type VirtualSessionDeps,
} from "../src/virtual-session.js";
import { WsHub } from "../src/ws-hub.js";
import { connectClient, connectFakeAgent, type TestClient, type FakeAgent } from "./helpers/harness.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("virtual session transport", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let client: TestClient | undefined;
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    client = undefined;
    agent = undefined;
    closeHub = undefined;
  });

  it("delivers a virtual session response through its sink without WebSocket fallback", async () => {
    const sendToSession = vi.spyOn(WsHub.prototype, "sendToSession");
    const hub = await createHub({ port: 0, requestTimeoutMs: 1_000 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-sink" });
    client = await connectClient(hub.port, { role: "cli", sessionId: "virtual-sink" });

    const session = hub.sessions.get("virtual-sink");
    expect(session).toBeDefined();
    let responseResolve: ((frame: object) => void) | undefined;
    const response = new Promise<object>((resolve) => {
      responseResolve = resolve;
    });
    session!.ws = null;
    session!.sink = (frame) => responseResolve?.(frame);

    client.ws.send(JSON.stringify({
      type: "request",
      id: "sink-roundtrip",
      action: "tab.list",
      sessionId: "virtual-sink",
    }));

    try {
      await expect(response).resolves.toMatchObject({
        type: "response",
        id: "sink-roundtrip",
        action: "tab.list",
      });
      expect(sendToSession).not.toHaveBeenCalled();
    } finally {
      sendToSession.mockRestore();
    }
  });

  it("assigns a new virtual session once and preserves browser preferences on reuse", async () => {
    const assignSession = vi.spyOn(HubRouter.prototype, "assignSession");
    const hub = await createHub({ port: 0, now: () => 100 });
    closeHub = hub.close;

    try {
      const first = hub.getOrCreateVirtualSession("virtual-preferred", {
        preferBrowserId: "browser-preferred",
        pinned: true,
      });
      const reused = hub.getOrCreateVirtualSession("virtual-preferred");

      expect(reused).toBe(first);
      expect(first.browserId).toBe("browser-preferred");
      expect(first.pinned).toBe(true);
      expect(assignSession).toHaveBeenCalledTimes(1);
      expect(assignSession).toHaveBeenCalledWith(first, false);
    } finally {
      assignSession.mockRestore();
    }
  });
});

describe("virtual session lifecycle", () => {
  it("returns the same object for a name and refreshes lastSeenAt", () => {
    let now = 100;
    const deps: VirtualSessionDeps = {
      sessions: new SessionRegistry(),
      now: () => now,
    };

    const first = getOrCreateVirtualSession(deps, "cli-a");
    first.currentTabId = 42;
    now = 250;

    const reused = getOrCreateVirtualSession(deps, "cli-a");

    expect(reused).toBe(first);
    expect(reused.lastSeenAt).toBe(250);
    expect(reused.currentTabId).toBe(42);
  });

  it("preserves tab state for one name while isolating another", () => {
    const deps: VirtualSessionDeps = {
      sessions: new SessionRegistry(),
      now: () => 100,
    };
    const first = getOrCreateVirtualSession(deps, "cli-a");
    first.currentTabId = 7;

    const same = getOrCreateVirtualSession(deps, "cli-a");
    const other = getOrCreateVirtualSession(deps, "cli-b");

    expect(same.currentTabId).toBe(7);
    expect(other).not.toBe(first);
    expect(other.currentTabId).toBeNull();
  });

  it("initializes the virtual session contract", () => {
    const deps: VirtualSessionDeps = {
      sessions: new SessionRegistry(),
      now: () => 100,
    };

    const session = getOrCreateVirtualSession(deps, "cli-a");

    expect(session).toMatchObject({
      sessionId: "cli-a",
      role: "cli",
      label: "cli-a",
      ws: null,
      wireVersion: VTX_WIRE_VERSION,
      connectedAt: 100,
      lastSeenAt: 100,
      browserId: null,
      lastBrowserId: null,
      rebindUntil: 0,
      currentTabId: null,
      claiming: null,
      pinned: false,
      strictTab: process.env.VORTEX_STRICT_TAB === "1",
    });
    expect(session.buffer).toEqual([]);
    expect(session.ownedTabs).toEqual(new Set());
    expect(deps.sessions.get("cli-a")).toBe(session);
  });

  it("removes idle no-pending virtual sessions and retains pending or WebSocket sessions", () => {
    let now = 200;
    const deps: VirtualSessionDeps = {
      sessions: new SessionRegistry(),
      now: () => now,
    };
    const idle = getOrCreateVirtualSession(deps, "idle");
    const pending = getOrCreateVirtualSession(deps, "pending");
    const websocket = getOrCreateVirtualSession(deps, "websocket");
    idle.lastSeenAt = 100;
    pending.lastSeenAt = 100;
    websocket.lastSeenAt = 100;
    websocket.ws = {} as never;

    const removed = sweepIdleVirtualSessions(deps, 50, (sessionId) => sessionId === "pending");

    expect(removed).toEqual(["idle"]);
    expect(deps.sessions.get("idle")).toBeUndefined();
    expect(deps.sessions.get("pending")).toBe(pending);
    expect(deps.sessions.get("websocket")).toBe(websocket);
  });
});
