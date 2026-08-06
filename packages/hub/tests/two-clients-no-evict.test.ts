/**
 * Author: qingwa
 * Description: Verifies independent live sessions do not evict one another.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("two clients without eviction", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent;
  const clients: TestClient[] = [];
  let port: number;

  beforeEach(async () => {
    const started = await startTestHub();
    port = started.port;
    closeHub = started.close;
    agent = await connectFakeAgent(port, { browserId: "browser-a" });
    clients.push(await connectClient(port, { sessionId: "session-a" }));
    clients.push(await connectClient(port, { sessionId: "session-b" }));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await agent.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("keeps both sessions connected and routes responses by id", async () => {
    const [first, second] = clients;
    expect(first.welcome.type).toBe("welcome");
    expect(second.welcome.type).toBe("welcome");
    expect(await Promise.race([first.closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))])).toBe(false);
    expect(await Promise.race([second.closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))])).toBe(false);

    const [firstResponse, secondResponse] = await Promise.all([
      first.request({ action: "first.action", id: "request-a", params: { owner: "a" } }),
      second.request({ action: "second.action", id: "request-b", params: { owner: "b" } }),
    ]);

    expect(firstResponse).toMatchObject({ id: "request-a", result: { echo: { owner: "a" } } });
    expect(secondResponse).toMatchObject({ id: "request-b", result: { echo: { owner: "b" } } });
  });
});
