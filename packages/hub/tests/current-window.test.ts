/**
 * Author: qingwa
 * Description: Verifies current-tab selection prefers the last-focused window.
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

describe("current-window tab selection", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await agent?.close();
    agent = undefined;
    await closeHub?.();
    closeHub = undefined;
  });

  function forwarded(action: string, sessionId: string): VtxRequest[] {
    return (agent?.messages ?? [])
      .filter((message): message is VtxRequest =>
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "request" &&
        (message as { action?: unknown }).action === action &&
        (message as { sessionId?: unknown }).sessionId === sessionId,
      );
  }

  async function firstScopedRequest(tabs: FakeAgent["tabs"]): Promise<VtxRequest> {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a", tabs });
    const client = await connectClient(started.port, { sessionId: "session-a" });
    clients.push(client);

    await client.request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      id: "navigate-a",
    });

    return forwarded("page.navigate", "session-a")[0];
  }

  it("claims the active unowned tab in the last-focused window first", async () => {
    const request = await firstScopedRequest([
      { id: 1, url: "https://background.test", title: "Background", active: true, windowId: 1 },
      { id: 2, url: "https://focused.test", title: "Focused", active: true, windowId: 2, lastFocused: true },
    ]);

    expect(request).toMatchObject({ tabId: 2, tabIdBackfilled: true });
  });

  it("falls back to the first active unowned tab when lastFocused is absent", async () => {
    const request = await firstScopedRequest([
      { id: 1, url: "https://first.test", title: "First", active: true, windowId: 1 },
      { id: 2, url: "https://second.test", title: "Second", active: true, windowId: 2 },
    ]);

    expect(request).toMatchObject({ tabId: 1, tabIdBackfilled: true });
  });
});
