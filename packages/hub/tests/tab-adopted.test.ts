/**
 * Author: qingwa
 * Description: Verifies explicit cross-session tab adoption and notice delivery.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("tab adoption", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("allows explicit adoption, updates ownership, and preserves the response body", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a" });
    const clientA = await connectClient(started.port, { sessionId: "session-a", label: "Agent A" });
    const clientB = await connectClient(started.port, { sessionId: "session-b", label: "Agent B" });
    clients.push(clientA, clientB);

    await clientA.request({ action: "page.navigate", params: { url: "https://owned.test" }, id: "claim-a" });
    const response = await clientB.request({
      action: "page.navigate",
      params: { url: "https://adopted.test" },
      id: "adopt-b",
      tabId: 1,
    });

    expect(response.result).toEqual({ echo: { url: "https://adopted.test" } });
    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(1)).toBe("session-b");
    expect(started.hub.sessions.get("session-a")?.ownedTabs.has(1)).toBe(false);
    expect(started.hub.sessions.get("session-b")).toMatchObject({ currentTabId: 1 });
    expect(clientB.notices).toContainEqual(expect.objectContaining({
      notice: "tab-adopted",
      tabId: 1,
      browserId: "browser-a",
    }));
  });
});
