/**
 * Description: Verifies an evicted same-session peer is told why before its socket closes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("session replacement notice", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let first: TestClient | undefined;
  let second: TestClient | undefined;

  afterEach(async () => {
    await first?.close();
    await second?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("notifies the displaced peer before closing its socket", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, { browserId: "browser-a" });
    first = await connectClient(started.port, { role: "cli", sessionId: "cli-lg" });

    second = await connectClient(started.port, { role: "cli", sessionId: "cli-lg" });

    const notice = await first.waitFor((message): message is { notice: string } =>
      typeof message === "object" && message !== null &&
      (message as { notice?: unknown }).notice === "session-replaced",
    );
    expect(notice.notice).toBe("session-replaced");
    await expect(first.closed).resolves.toMatchObject({ code: 1000 });
  });
});
