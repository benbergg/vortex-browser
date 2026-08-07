/**
 * Author: qingwa
 * Description: Verifies browser grace-period restore and failover behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("browser down and up", () => {
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
    agent = await connectFakeAgent(port, { browserId: "browser-a" });
    client = await connectClient(port, { sessionId: "session-a" });
    await client.request({ action: "tab.create", id: "create-a" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await client?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("restores the same browser and flushes buffered work within grace", async () => {
    await agent.close();
    await client.waitFor((message): message is { type: "notice"; notice: string } =>
      typeof message === "object" && message !== null &&
      (message as { notice?: unknown }).notice === "browser-lost",
    );
    const buffered = client.request({ action: "buffered.action", id: "buffered-1" });
    const restored = await connectFakeAgent(port, { browserId: "browser-a" });
    agent = restored;

    await client.waitFor((message): message is { type: "notice"; notice: string } =>
      typeof message === "object" && message !== null &&
      (message as { notice?: unknown }).notice === "browser-restored",
    );
    await expect(buffered).resolves.toMatchObject({ id: "buffered-1", result: { echo: null } });
    expect(hub.sessions.get("session-a")).toMatchObject({ browserId: "browser-a", currentTabId: 2 });
    expect(hub.sessions.get("session-a")?.ownedTabs.has(2)).toBe(true);
    expect(hub.browsers.get("browser-a")?.tabOwner.get(2)).toBe("session-a");
  });

  it("clears tab ownership after grace and assigns a replacement browser", async () => {
    vi.useFakeTimers();
    await agent.close();
    await client.waitFor((message): message is { type: "notice"; notice: string } =>
      typeof message === "object" && message !== null &&
      (message as { notice?: unknown }).notice === "browser-lost",
    );
    vi.setSystemTime(Date.now() + 15_001);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();

    expect(hub.sessions.get("session-a")).toMatchObject({ browserId: null, currentTabId: null });
    expect(hub.sessions.get("session-a")?.ownedTabs.size).toBe(0);
    const replacement = await connectFakeAgent(port, { browserId: "browser-b" });
    agent = replacement;
    await client.waitFor((message): message is { type: "notice"; notice: string } =>
      typeof message === "object" && message !== null &&
      (message as { notice?: unknown }).notice === "browser-assigned",
    );
    expect(hub.sessions.get("session-a")?.browserId).toBe("browser-b");
  });
});
