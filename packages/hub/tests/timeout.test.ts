/**
 * Author: qingwa
 * Description: Verifies hub-owned timeout cleanup across all pending indexes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("hub request timeout", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent;
  let client: TestClient;
  let hub: Awaited<ReturnType<typeof startTestHub>>["hub"];
  let port: number;

  beforeEach(async () => {
    const started = await startTestHub();
    hub = started.hub;
    port = started.port;
    closeHub = started.close;
    agent = await connectFakeAgent(port, { browserId: "browser-a", handle: () => new Promise(() => {}) });
    client = await connectClient(port, { sessionId: "session-a" });
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([client?.close(), agent?.close()]);
    await closeHub?.();
    closeHub = undefined;
  });

  it("returns TIMEOUT and removes all three pending indexes", async () => {
    const arrived = new Promise<void>((resolve) => {
      const listener = (data: Buffer) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type !== "request") return;
        agent.ws.off("message", listener);
        resolve();
      };
      agent.ws.on("message", listener);
    });
    const response = client.request({ action: "slow.action", id: "slow-1", tabId: 1 });
    await arrived;
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();

    await expect(response).resolves.toMatchObject({ error: { code: "TIMEOUT" } });
    expect(hub.pending.indexSizes).toEqual({ byId: 0, bySession: 0, byBrowser: 0 });
  });
});
