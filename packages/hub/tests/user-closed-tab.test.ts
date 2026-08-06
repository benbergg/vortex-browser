/**
 * Author: qingwa
 * Description: Verifies user-closed events remove tab ownership and current state.
 */
import { afterEach, describe, expect, it } from "vitest";
import { VtxEventType } from "@vortex-browser/shared";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("user closed tab", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("clears ownership and currentTabId for the closed tab", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a" });
    client = await connectClient(started.port, { sessionId: "session-a" });
    await client.request({ action: "page.navigate", params: { url: "https://one.test" }, id: "claim-a" });

    agent.emit({ event: VtxEventType.USER_CLOSED_TAB, data: { windowId: 1 }, tabId: 1 });
    await client.waitFor((message): message is { type: "event"; event: string } =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "event" &&
      (message as { event?: unknown }).event === VtxEventType.USER_CLOSED_TAB,
    );

    expect(started.hub.browsers.get("browser-a")?.tabOwner.has(1)).toBe(false);
    expect(started.hub.sessions.get("session-a")?.ownedTabs.has(1)).toBe(false);
    expect(started.hub.sessions.get("session-a")?.currentTabId).toBeNull();
  });
});
