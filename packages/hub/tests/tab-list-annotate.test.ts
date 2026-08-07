/**
 * Author: qingwa
 * Description: Verifies tab ownership annotations, ordering, and owned filtering.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("tab.list annotations", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("marks self, other, and unowned tabs, puts self first, and filters owned tabs", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      tabs: [
        { id: 1, url: "https://one.test", title: "One", active: true },
        { id: 2, url: "https://two.test", title: "Two", active: false },
        { id: 3, url: "https://three.test", title: "Three", active: false },
      ],
    });
    const clientA = await connectClient(started.port, { sessionId: "session-a", label: "Agent A" });
    const clientB = await connectClient(started.port, { sessionId: "session-b", label: "Agent B" });
    clients.push(clientA, clientB);

    await clientA.request({ action: "page.navigate", params: { url: "https://a.test" }, id: "claim-a" });
    await clientB.request({ action: "page.navigate", params: { url: "https://b.test" }, id: "claim-b" });

    const all = await clientA.request({ action: "tab.list", params: {}, id: "list-all" });
    const tabs = all.result as Array<Record<string, unknown>>;
    expect(tabs.map((tab) => tab.id)).toEqual([1, 2, 3]);
    expect(tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, owner: "self", ownerLabel: "Agent A", current: true, browserId: "browser-a", browserLabel: "browser-a" }),
      expect.objectContaining({ id: 2, owner: "other", ownerLabel: "Agent B", current: false, browserId: "browser-a", browserLabel: "browser-a" }),
      expect.objectContaining({ id: 3, owner: "none", current: false, browserId: "browser-a", browserLabel: "browser-a" }),
    ]));

    const owned = await clientA.request({ action: "tab.list", params: { owned: true }, id: "list-owned" });
    expect((owned.result as Array<Record<string, unknown>>).map((tab) => tab.id)).toEqual([1]);
  });
});
