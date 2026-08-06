/**
 * Author: qingwa
 * Description: Verifies same-session replacement preserves routing state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubHandle } from "../src/hub.js";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("same-session reconnect", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let hub: HubHandle;
  let agent: FakeAgent;
  let port: number;
  let first: TestClient;
  let other: TestClient;
  let replacement: TestClient;

  beforeEach(async () => {
    const started = await startTestHub();
    port = started.port;
    hub = started.hub;
    closeHub = started.close;
    agent = await connectFakeAgent(port, { browserId: "browser-a" });
    first = await connectClient(port, { sessionId: "session-a" });
    other = await connectClient(port, { sessionId: "session-b" });
    await first.request({ action: "tab.create", id: "create-a" });
  });

  afterEach(async () => {
    await Promise.all(
      [first, other, replacement].filter(Boolean).map((client) => client.close()),
    );
    await agent.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("replaces only the matching session and preserves state and pending work", async () => {
    let releaseOther!: (response: { action: string; id: string; result: unknown }) => void;
    let unblockOther!: () => void;
    let otherHubRequestId = "";
    const otherBlocked = new Promise<void>((resolve) => { unblockOther = resolve; });
    agent.ws.removeAllListeners("message");
    agent.ws.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { type?: string; id: string; action: string };
      if (request.type !== "request") return;
      if (request.id.startsWith("session-b#")) {
        otherHubRequestId = request.id;
        unblockOther();
        releaseOther = (response) => {
          agent.ws.send(JSON.stringify({ ...response, type: "response" }));
        };
        return;
      }
      agent.ws.send(JSON.stringify({
        type: "response",
        action: request.action,
        id: request.id,
        result: { ok: true },
      }));
    });

    const pendingOther = other.request({ action: "slow.action", id: "slow-b", tabId: 1 });
    await otherBlocked;
    replacement = await connectClient(port, { sessionId: "session-a" });
    const oldClose = await first.closed;

    expect(oldClose).toEqual({ code: 1000, reason: "replaced by same-session reconnect" });
    expect(replacement.welcome.type).toBe("welcome");
    expect(other.ws.readyState).toBe(1);

    const session = hub.sessions.get("session-a");
    expect(session).toMatchObject({ browserId: "browser-a", currentTabId: 2 });
    expect(session?.ownedTabs.has(2)).toBe(true);

    releaseOther({ action: "slow.action", id: otherHubRequestId, result: { done: true } });
    await expect(pendingOther).resolves.toMatchObject({ result: { done: true } });
  });
});
