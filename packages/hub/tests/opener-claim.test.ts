/**
 * Author: qingwa
 * Description: Verifies opener-based ownership without changing the current tab.
 */
import { afterEach, describe, expect, it } from "vitest";
import { VtxEventType } from "@vortex-browser/shared";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("opener tab claim", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("claims a tab opened from an owned tab and keeps currentTabId unchanged", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      tabs: [
        { id: 1, url: "https://one.test", title: "One", active: true },
        { id: 2, url: "https://two.test", title: "Two", active: false },
      ],
    });
    const clientA = await connectClient(started.port, { sessionId: "session-a" });
    const clientB = await connectClient(started.port, { sessionId: "session-b" });
    clients.push(clientA, clientB);
    await clientA.request({ action: "page.navigate", params: { url: "https://one.test" }, id: "claim-a" });

    agent.emit({ event: VtxEventType.USER_OPENED_TAB, data: { openerTabId: 1 }, tabId: 2 });
    await clientA.waitFor((message): message is { type: "event"; event: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "event" &&
      (message as { event?: unknown }).event === VtxEventType.USER_OPENED_TAB,
    );

    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(2)).toBe("session-a");
    expect(started.hub.sessions.get("session-a")?.ownedTabs.has(2)).toBe(true);
    expect(started.hub.sessions.get("session-a")?.currentTabId).toBe(1);
    expect(clientB.events.some((event) => event.event === VtxEventType.USER_OPENED_TAB)).toBe(false);
  });
});
