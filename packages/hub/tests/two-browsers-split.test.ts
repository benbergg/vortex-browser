/**
 * Author: qingwa
 * Description: Verifies independent sessions split across idle browsers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("two browser allocation", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agents: FakeAgent[] = [];
  let clients: TestClient[] = [];
  let port: number;

  beforeEach(async () => {
    const started = await startTestHub();
    port = started.port;
    closeHub = started.close;
    agents = [
      await connectFakeAgent(port, { browserId: "browser-a" }),
      await connectFakeAgent(port, { browserId: "browser-b" }),
    ];
    clients = [
      await connectClient(port, { sessionId: "session-a" }),
      await connectClient(port, { sessionId: "session-b" }),
    ];
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(agents.splice(0).map((agent) => agent.close()));
    await closeHub?.();
    closeHub = undefined;
  });

  it("assigns two sessions to different browser agents", () => {
    expect(clients[0].welcome.assignedBrowserId).not.toBe(clients[1].welcome.assignedBrowserId);
    expect(new Set(clients.map((client) => client.welcome.assignedBrowserId)).size).toBe(2);
  });
});
