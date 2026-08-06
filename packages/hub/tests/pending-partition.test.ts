/**
 * Author: qingwa
 * Description: Verifies pending failures stay partitioned by session.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("pending partition", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agentA: FakeAgent;
  let agentB: FakeAgent;
  let clientA: TestClient;
  let clientB: TestClient;
  let hub: Awaited<ReturnType<typeof startTestHub>>["hub"];
  let port: number;

  beforeEach(async () => {
    const started = await startTestHub();
    hub = started.hub;
    port = started.port;
    closeHub = started.close;
    agentA = await connectFakeAgent(port, { browserId: "browser-a", handle: () => new Promise(() => {}) });
    agentB = await connectFakeAgent(port, { browserId: "browser-b", handle: () => new Promise(() => {}) });
    clientA = await connectClient(port, { sessionId: "session-a" });
    clientB = await connectClient(port, { sessionId: "session-b" });
  });

  afterEach(async () => {
    await Promise.all([clientA?.close(), clientB?.close(), agentA?.close(), agentB?.close()]);
    await closeHub?.();
    closeHub = undefined;
  });

  it("fails only the pending requests belonging to a disconnected browser", async () => {
    const a = [
      clientA.request({ action: "a.one", id: "a-1" }),
      clientA.request({ action: "a.two", id: "a-2" }),
    ];
    const b = [
      clientB.request({ action: "b.one", id: "b-1" }),
      clientB.request({ action: "b.two", id: "b-2" }),
    ];

    await clientA.close();
    for (let attempt = 0; attempt < 20 && hub.pending.indexSizes.byId !== 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hub.pending.indexSizes).toEqual({ byId: 2, bySession: 1, byBrowser: 1 });
    expect(await Promise.race([b[0].then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))])).toBe(false);
    expect(await Promise.race([b[1].then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))])).toBe(false);

    await agentB.close();
    const bResponses = await Promise.all(b);
    expect(bResponses.every((response) => response.error?.code === "EXTENSION_NOT_CONNECTED")).toBe(true);
  });
});
