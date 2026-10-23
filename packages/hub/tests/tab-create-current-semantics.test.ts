/**
 * Author: qingwa
 * Description: Locks the tab.create -> session current semantics.
 * Default/true take over the session current, strict false keeps the previous current.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { VtxRequest } from "@vortex-browser/shared";
import {
  connectClient,
  connectFakeAgent,
  startTestHub,
  type FakeAgent,
  type TestClient,
} from "./helpers/harness.js";
import * as tabOwnership from "../src/tab-ownership.js";

describe("tab.create current semantics", () => {
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

  async function setup(tabs?: FakeAgent["tabs"]) {
    const started = await startTestHub({ requestTimeoutMs: 1_000 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a", tabs });
    return started;
  }

  async function client(port: number, sessionId: string): Promise<TestClient> {
    const connected = await connectClient(port, { sessionId });
    clients.push(connected);
    return connected;
  }

  function forwarded(action: string): VtxRequest[] {
    return (agent?.messages ?? []).filter((message): message is VtxRequest =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "request" &&
      (message as { action?: unknown }).action === action,
    );
  }

  async function createTab(
    port: number,
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; tabId: number | undefined }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/tab/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vortex-session": sessionId,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { result?: { id?: unknown } };
    return {
      status: response.status,
      tabId: typeof payload.result?.id === "number" ? payload.result.id : undefined,
    };
  }

  it("makes the new tab current when active is omitted", async () => {
    const started = await setup();

    const created = await createTab(started.port, "sem-default", {});

    expect(created.status).toBe(200);
    expect(created.tabId).toEqual(expect.any(Number));
    expect(started.hub.sessions.get("sem-default")?.currentTabId).toBe(created.tabId);
  });

  it("makes the new tab current when active is true", async () => {
    const started = await setup();

    const created = await createTab(started.port, "sem-true", { active: true });

    expect(created.status).toBe(200);
    expect(created.tabId).toEqual(expect.any(Number));
    expect(started.hub.sessions.get("sem-true")?.currentTabId).toBe(created.tabId);
  });

  it("keeps the previous current tab when active is false", async () => {
    const started = await setup();

    const foreground = await createTab(started.port, "sem-false", {});
    expect(foreground.tabId).toEqual(expect.any(Number));
    expect(started.hub.sessions.get("sem-false")?.currentTabId).toBe(foreground.tabId);

    const background = await createTab(started.port, "sem-false", { active: false });
    expect(background.status).toBe(200);
    expect(background.tabId).toEqual(expect.any(Number));
    expect(background.tabId).not.toBe(foreground.tabId);

    // 后台 tab 归本 session,但不夺取 current
    expect(started.hub.sessions.get("sem-false")?.currentTabId).toBe(foreground.tabId);
    expect(started.hub.browsers.get("browser-a")?.tabOwner.get(background.tabId!)).toBe("sem-false");
  });

  it("routes a request without tabId to the unchanged current tab after a background create", async () => {
    const started = await setup();
    const foreground = await createTab(started.port, "sem-route", {});
    await createTab(started.port, "sem-route", { active: false });

    const response = await fetch(`http://127.0.0.1:${started.port}/api/page/info`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vortex-session": "sem-route",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const pageInfo = forwarded("page.info");
    expect(pageInfo).toHaveLength(1);
    expect(pageInfo[0].tabId).toBe(foreground.tabId);
    expect(started.hub.sessions.get("sem-route")?.currentTabId).toBe(foreground.tabId);
  });

  it("still claims the hub-created background tab as current on the internal ensureCurrentTab path", async () => {
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

    // hub 内部自建的是后台 tab,current 由 claimWithoutAdoption 显式设置
    const internalCreate = forwarded("tab.create");
    expect(internalCreate).toHaveLength(1);
    expect(internalCreate[0].params).toMatchObject({ active: false });

    const session = started.hub.sessions.get("session-c");
    const browser = started.hub.browsers.get("browser-a");
    expect(session?.currentTabId).toEqual(expect.any(Number));
    expect(browser?.tabOwner.get(session!.currentTabId!)).toBe("session-c");
  });

  it("classifies tab.create params by strict boolean active", () => {
    expect(tabOwnership.shouldBecomeCurrentAfterCreate(undefined)).toBe(true);
    expect(tabOwnership.shouldBecomeCurrentAfterCreate({})).toBe(true);
    expect(tabOwnership.shouldBecomeCurrentAfterCreate({ active: true })).toBe(true);
    expect(tabOwnership.shouldBecomeCurrentAfterCreate({ active: false })).toBe(false);
    expect(tabOwnership.shouldBecomeCurrentAfterCreate({ active: "false" })).toBe(true);
  });
});
