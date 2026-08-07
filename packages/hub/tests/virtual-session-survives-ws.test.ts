/**
 * Description: A CLI --follow socket closing must not destroy the session HTTP commands share.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("virtual session outlives its WebSocket", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let follower: TestClient | undefined;

  afterEach(async () => {
    await follower?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("keeps the current tab after a follow socket disconnects", async () => {
    const started = await startTestHub({ requestTimeoutMs: 1_000 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a" });
    const headers = { "content-type": "application/json", "x-vortex-session": "cli-lg" };

    const created = await fetch(`http://127.0.0.1:${started.port}/api/tab/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(200);
    const claimedTabId = started.hub.sessions.get("cli-lg")?.currentTabId;
    expect(claimedTabId).toEqual(expect.any(Number));

    // 同名 WS 接上再断开，等价于 vortex console subscribe 后 Ctrl-C
    follower = await connectClient(started.port, { role: "cli", sessionId: "cli-lg" });
    await follower.close();
    follower = undefined;
    await waitUntil(() => started.hub.sessions.get("cli-lg")?.ws == null);

    const session = started.hub.sessions.get("cli-lg");
    expect(session).toBeDefined();
    expect(session?.currentTabId).toBe(claimedTabId);
    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(claimedTabId!)).toBe("cli-lg");

    const info = await fetch(`http://127.0.0.1:${started.port}/api/page/info`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(info.status).toBe(200);
    expect(started.hub.sessions.get("cli-lg")?.currentTabId).toBe(claimedTabId);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for hub state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
