/**
 * Author: qingwa
 * Description: Verifies owned, unowned, and global event fanout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("event fanout", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent;
  let clientA: TestClient;
  let clientB: TestClient;
  let port: number;

  beforeEach(async () => {
    const started = await startTestHub();
    port = started.port;
    closeHub = started.close;
    agent = await connectFakeAgent(port, { browserId: "browser-a" });
    clientA = await connectClient(port, { sessionId: "session-a" });
    clientB = await connectClient(port, { sessionId: "session-b" });
    await clientA.request({ action: "tab.create", id: "create-a" });
  });

  afterEach(async () => {
    await Promise.all([clientA?.close(), clientB?.close(), agent?.close()]);
    await closeHub?.();
    closeHub = undefined;
  });

  it("routes owned events only to the owner and marks unowned broadcasts", async () => {
    agent.emit({ event: "owned.event", data: { value: 1 }, tabId: 2 });
    await clientA.waitFor((message): message is { type: "event"; event: string } =>
      typeof message === "object" && message !== null &&
      (message as { event?: unknown }).event === "owned.event",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(clientA.events.some((event) => event.event === "owned.event")).toBe(true);
    expect(clientB.events.some((event) => event.event === "owned.event")).toBe(false);

    agent.emit({ event: "unowned.event", data: { value: 2 }, tabId: 99 });
    await Promise.all([
      clientA.waitFor((message): message is { type: "event"; event: string; unowned?: boolean } =>
        typeof message === "object" && message !== null &&
        (message as { event?: unknown }).event === "unowned.event",
      ),
      clientB.waitFor((message): message is { type: "event"; event: string; unowned?: boolean } =>
        typeof message === "object" && message !== null &&
        (message as { event?: unknown }).event === "unowned.event",
      ),
    ]);
    expect(clientA.events.find((event) => event.event === "unowned.event")?.unowned).toBe(true);
    expect(clientB.events.find((event) => event.event === "unowned.event")?.unowned).toBe(true);

    agent.emit({ event: "global.event", data: { value: 3 } });
    await Promise.all([
      clientA.waitFor((message): message is { type: "event"; event: string } =>
        typeof message === "object" && message !== null &&
        (message as { event?: unknown }).event === "global.event",
      ),
      clientB.waitFor((message): message is { type: "event"; event: string } =>
        typeof message === "object" && message !== null &&
        (message as { event?: unknown }).event === "global.event",
      ),
    ]);
  });
});
