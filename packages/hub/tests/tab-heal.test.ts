/**
 * Author: qingwa
 * Description: Verifies one-shot healing for hub-backfilled tab errors.
 */
import { afterEach, describe, expect, it } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("tab healing", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  it("re-fetches a hub-backfilled tab and retries exactly once", async () => {
    let navigateAttempts = 0;
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request) => {
        if (request.action === "tab.list") {
          return { action: request.action, id: request.id, result: agent?.tabs.slice() };
        }
        if (request.action === "page.navigate" && navigateAttempts++ === 0) {
          return {
            action: request.action,
            id: request.id,
            error: { code: VtxErrorCode.TAB_NOT_FOUND, message: "first tab disappeared" },
          };
        }
        return { action: request.action, id: request.id, result: { ok: true } };
      },
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const response = await client.request({ action: "page.navigate", params: { url: "https://target.test" }, id: "heal-me" });

    expect(response.error).toBeUndefined();
    expect(navigateAttempts).toBe(2);
    expect(agent.messages.filter((message) =>
      typeof message === "object" && message !== null &&
      (message as { action?: unknown }).action === "page.navigate",
    )).toHaveLength(2);
  });

  it("returns an explicit-tab TAB_NOT_FOUND without retrying or changing the target", async () => {
    let navigateAttempts = 0;
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request) => {
        if (request.action === "page.navigate") {
          navigateAttempts++;
          return {
            action: request.action,
            id: request.id,
            error: {
              code: VtxErrorCode.TAB_NOT_FOUND,
              message: "explicit tab is gone",
              hint: "keep this hint",
            },
          };
        }
        return { action: request.action, id: request.id, result: agent?.tabs.slice() ?? [] };
      },
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const response = await client.request({ action: "page.navigate", params: { url: "https://target.test" }, id: "explicit-missing", tabId: 999 });

    expect(navigateAttempts).toBe(1);
    expect(response.error).toEqual({
      code: VtxErrorCode.TAB_NOT_FOUND,
      message: "explicit tab is gone",
      hint: "keep this hint",
    });
  });
});
