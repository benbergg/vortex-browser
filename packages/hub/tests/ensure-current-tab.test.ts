/**
 * Author: qingwa
 * Description: Verifies current-tab selection, conflict handling, and claim serialization.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  connectClient,
  connectFakeAgent,
  startTestHub,
  type FakeAgent,
  type TestClient,
} from "./helpers/harness.js";
import type { VtxRequest } from "@vortex-browser/shared";

describe("ensureCurrentTab", () => {
  let closeHub: (() => Promise<void>) | undefined;
  const clients: TestClient[] = [];
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await agent?.close();
    agent = undefined;
    await closeHub?.();
    closeHub = undefined;
  });

  async function setup(tabs: FakeAgent["tabs"] = [{ id: 1, url: "https://one.test", title: "One", active: true }]) {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a", tabs });
    return started;
  }

  async function client(port: number, sessionId: string): Promise<TestClient> {
    const connected = await connectClient(port, { sessionId });
    clients.push(connected);
    return connected;
  }

  function forwarded(action: string, sessionId?: string): VtxRequest[] {
    return (agent?.messages ?? [])
      .filter((message): message is VtxRequest =>
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "request" &&
        (message as { action?: unknown }).action === action &&
        (sessionId === undefined || (message as { sessionId?: unknown }).sessionId === sessionId),
      );
  }

  it("claims an unowned active tab on the first scoped request", async () => {
    const started = await setup();
    const session = await client(started.port, "session-a");

    await session.request({ action: "page.navigate", params: { url: "https://target.test" }, id: "navigate-a" });

    expect(forwarded("page.navigate", "session-a")[0]).toMatchObject({
      tabId: 1,
      tabIdBackfilled: true,
    });
    expect(started.hub.sessions.get("session-a")).toMatchObject({ currentTabId: 1 });
    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(1)).toBe("session-a");
    expect(forwarded("tab.create")).toHaveLength(0);
  });

  it("chooses an unowned non-active tab when the active tab belongs to another session", async () => {
    const started = await setup([
      { id: 1, url: "https://one.test", title: "One", active: true },
      { id: 2, url: "https://two.test", title: "Two", active: false },
    ]);
    const sessionA = await client(started.port, "session-a");
    const sessionB = await client(started.port, "session-b");

    await sessionA.request({ action: "page.navigate", params: { url: "https://a.test" }, id: "navigate-a" });
    await sessionB.request({ action: "page.navigate", params: { url: "https://b.test" }, id: "navigate-b" });

    expect(forwarded("page.navigate", "session-b")[0]).toMatchObject({
      tabId: 2,
      tabIdBackfilled: true,
    });
    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(1)).toBe("session-a");
    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(2)).toBe("session-b");
  });

  it("creates a background tab only when every usable tab is owned", async () => {
    const started = await setup([
      { id: 1, url: "https://one.test", title: "One", active: true },
      { id: 2, url: "https://two.test", title: "Two", active: false },
    ]);
    const sessionA = await client(started.port, "session-a");
    const sessionB = await client(started.port, "session-b");
    const sessionC = await client(started.port, "session-c");

    await sessionA.request({ action: "page.navigate", params: { url: "https://a.test" }, id: "navigate-a" });
    await sessionB.request({ action: "page.navigate", params: { url: "https://b.test" }, id: "navigate-b" });
    await sessionC.request({ action: "page.navigate", params: { url: "https://c.test" }, id: "navigate-c" });

    expect(forwarded("tab.create")).toHaveLength(1);
    expect(forwarded("tab.create")[0]).toMatchObject({ params: { active: false } });
    expect(forwarded("page.navigate", "session-c")[0]).toMatchObject({
      tabId: 3,
      tabIdBackfilled: true,
    });
    expect(started.hub.sessions.get("session-c")).toMatchObject({ currentTabId: 3 });
  });

  it("serializes five concurrent first requests into one tab creation", async () => {
    const started = await setup([
      { id: 1, url: "https://one.test", title: "One", active: true },
      { id: 2, url: "https://two.test", title: "Two", active: false },
    ]);
    const sessionA = await client(started.port, "session-a");
    const sessionB = await client(started.port, "session-b");
    const sessionC = await client(started.port, "session-c");

    await sessionA.request({ action: "page.navigate", params: { url: "https://a.test" }, id: "navigate-a" });
    await sessionB.request({ action: "page.navigate", params: { url: "https://b.test" }, id: "navigate-b" });

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        sessionC.request({
          action: "page.navigate",
          params: { url: `https://c-${index}.test` },
          id: `navigate-c-${index}`,
        }),
      ),
    );

    expect(forwarded("tab.create")).toHaveLength(1);
    expect(agent?.tabs).toHaveLength(3);
    expect(new Set(forwarded("page.navigate", "session-c").map((request) => request.tabId))).toEqual(new Set([3]));
  });
});
