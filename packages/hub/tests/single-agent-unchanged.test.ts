/**
 * Author: qingwa
 * Description: Locks the single-session no-new-tab behavior.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("single-agent unchanged behavior", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("claims the active tab and never creates a tab for one session", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a" });
    client = await connectClient(started.port, { sessionId: "session-a" });

    await client.request({ action: "page.navigate", params: { url: "https://target.test" }, id: "navigate-a" });

    expect(agent.messages.filter((message) =>
      typeof message === "object" && message !== null &&
      (message as { action?: unknown }).action === "tab.create",
    )).toHaveLength(0);
    expect(started.hub.sessions.get("session-a")?.currentTabId).toBe(1);
  });
});
