/**
 * Author: qingwa
 * Description: Verifies browser-internal pages are never claimed as work tabs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isInternalUrl } from "../src/tab-ownership.js";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("internal tab URLs", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it.each([
    "chrome://newtab/",
    "chrome://downloads/",
    "chrome://downloads-manager/",
    "devtools://devtools/bundled/inspector.html",
    "chrome-devtools://devtools/bundled/inspector.html",
  ])("rejects %s", (url) => {
    expect(isInternalUrl(url)).toBe(true);
  });

  it("does not claim an internal active tab and creates a usable background tab", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      tabs: [{ id: 1, url: "chrome://downloads/", title: "Downloads", active: true }],
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    await client.request({ action: "page.navigate", params: { url: "https://usable.test" }, id: "navigate-a" });

    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(1)).toBeUndefined();
    expect(started.hub.sessions.get("session-a")?.currentTabId).toBe(2);
    expect(agent.tabs).toContainEqual(expect.objectContaining({ id: 2 }));
  });
});
