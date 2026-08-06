/**
 * Author: qingwa
 * Description: Verifies two missed WebSocket pongs terminate a half-open peer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectClient, startTestHub, type TestClient } from "./helpers/harness.js";

describe("hub WebSocket heartbeat", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let client: TestClient;
  let port: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    const started = await startTestHub();
    port = started.port;
    closeHub = started.close;
    client = await connectClient(port, { sessionId: "heartbeat-session" });
    (client.ws as unknown as { _autoPong?: boolean })._autoPong = false;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await client?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("terminates after two missed pong intervals", async () => {
    await vi.advanceTimersByTimeAsync(45_000);
    vi.useRealTimers();

    await expect(client.closed).resolves.toMatchObject({ code: 1006 });
  });
});
