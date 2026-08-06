/**
 * Author: qingwa
 * Description: Verifies fail-closed behavior when hub tab resolution fails.
 */
import { afterEach, describe, expect, it } from "vitest";
import { VtxErrorCode, type VtxRequest, type VtxResponse } from "@vortex-browser/shared";
import {
  connectClient,
  connectFakeAgent,
  startTestHub,
  type FakeAgent,
  type TestClient,
} from "./helpers/harness.js";

describe("tab resolution failures", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    client = undefined;
    agent = undefined;
    closeHub = undefined;
  });

  it("shares the default request deadline with a slow tab.list", async () => {
    const started = await startTestHub();
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: async (request): Promise<VtxResponse> => {
        if (request.action === "tab.list") await delay(150);
        if (request.action === "tab.list") {
          return { action: request.action, id: request.id, result: agent?.tabs.slice() ?? [] };
        }
        return { action: request.action, id: request.id, result: { ok: true } };
      },
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const response = await client.request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      id: "slow-list",
    });

    expect(response.error).toBeUndefined();
    expect(forwarded(agent, "page.navigate")).toHaveLength(1);
    expect(forwarded(agent, "page.navigate")[0]).toMatchObject({
      tabId: 1,
      tabIdBackfilled: true,
    });
  });

  it("fails closed when tab.list never responds", async () => {
    const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
    const started = await startTestHub({
      requestTimeoutMs: 40,
      onWarn: (message, details) => warnings.push({ message, details }),
    });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request): Promise<VtxResponse> => {
        if (request.action === "tab.list") return new Promise(() => {});
        return Promise.resolve({ action: request.action, id: request.id, result: { ok: true } });
      },
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const response = await client.request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      id: "missing-list",
    });

    expect(response.error).toMatchObject({ code: VtxErrorCode.TAB_NOT_FOUND });
    expect(response.error?.hint).toMatch(/hub.*tab.*resolution/i);
    expect(response.error?.context?.extras).toMatchObject({
      sessionId: "session-a",
      action: "page.navigate",
    });
    expect(String(response.error?.context?.extras?.reason)).toMatch(/timed out|timeout/i);
    expect(forwarded(agent, "page.navigate")).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/tab resolution/i);
    expect(warnings[0].details).toMatchObject({
      sessionId: "session-a",
      action: "page.navigate",
    });
    expect(String(warnings[0].details.reason)).toMatch(/timed out|timeout/i);
  });

  it("fails closed when tab.list returns an agent error", async () => {
    const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
    const started = await startTestHub({
      onWarn: (message, details) => warnings.push({ message, details }),
    });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request): VtxResponse => {
        if (request.action === "tab.list") {
          return {
            action: request.action,
            id: request.id,
            error: { code: VtxErrorCode.INTERNAL_ERROR, message: "tab enumeration failed" },
          };
        }
        return { action: request.action, id: request.id, result: { ok: true } };
      },
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const response = await client.request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      id: "error-list",
    });

    expect(response.error).toMatchObject({ code: VtxErrorCode.TAB_NOT_FOUND });
    expect(response.error?.hint).toMatch(/hub.*tab.*resolution/i);
    expect(response.error?.context?.extras).toMatchObject({
      sessionId: "session-a",
      action: "page.navigate",
      reason: "tab enumeration failed",
    });
    expect(forwarded(agent, "page.navigate")).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].details).toMatchObject({
      sessionId: "session-a",
      action: "page.navigate",
      reason: "tab enumeration failed",
    });
  });

  it("sends TAB_NOT_FOUND when the warning sink throws", async () => {
    const started = await startTestHub({
      onWarn: () => {
        throw new Error("warning sink failed");
      },
    });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request): VtxResponse => {
        if (request.action === "tab.list") {
          return {
            action: request.action,
            id: request.id,
            error: { code: VtxErrorCode.INTERNAL_ERROR, message: "tab enumeration failed" },
          };
        }
        return { action: request.action, id: request.id, result: { ok: true } };
      },
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const request: VtxRequest = {
      action: "page.navigate",
      params: { url: "https://target.test" },
      id: "warning-sink-error",
    };
    client.ws.send(JSON.stringify({ ...request, type: "request" }));

    const response = await client.waitFor<VtxResponse>((message): message is VtxResponse =>
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "response" &&
      (message as { id?: unknown }).id === request.id,
    );

    expect(response.error).toMatchObject({ code: VtxErrorCode.TAB_NOT_FOUND });
    expect(forwarded(agent, "page.navigate")).toHaveLength(0);
  });

  it("fails closed without sending tab resolution or business requests when the budget is zero", async () => {
    const started = await startTestHub({ requestTimeoutMs: 0, onWarn: () => {} });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request): VtxResponse => {
        if (request.action === "tab.list") {
          return { action: request.action, id: request.id, result: agent?.tabs.slice() ?? [] };
        }
        return { action: request.action, id: request.id, result: { ok: true } };
      },
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const response = await client.request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      id: "zero-budget",
    });

    expect(response.error).toMatchObject({ code: VtxErrorCode.TAB_NOT_FOUND });
    expect(forwarded(agent, "tab.list")).toHaveLength(0);
    expect(forwarded(agent, "page.navigate")).toHaveLength(0);
  });

  it("returns TIMEOUT without warning when an owned current tab is already available", async () => {
    const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
    const started = await startTestHub({
      requestTimeoutMs: 0,
      onWarn: (message, details) => warnings.push({ message, details }),
    });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: (request): VtxResponse => ({
        action: request.action,
        id: request.id,
        result: { ok: true },
      }),
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const session = started.hub.sessions.get("session-a");
    const browser = started.hub.browsers.get("browser-a");
    if (!session || !browser) throw new Error("Test harness did not register session and browser");
    session.currentTabId = 1;
    session.ownedTabs.add(1);
    browser.tabOwner.set(1, "session-a");

    const response = await client.request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      tabIdBackfilled: true,
      id: "owned-current-zero-budget",
    });

    expect(response.error).toMatchObject({ code: VtxErrorCode.TIMEOUT });
    expect(warnings).toHaveLength(0);
    expect(forwarded(agent, "tab.list")).toHaveLength(0);
    expect(forwarded(agent, "page.navigate")).toHaveLength(0);
  });

  it("returns TIMEOUT without forwarding an explicit-tab request when the budget is zero", async () => {
    const started = await startTestHub({ requestTimeoutMs: 0 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: () => new Promise(() => {}),
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const response = await client.request({
      action: "page.navigate",
      params: { url: "https://target.test" },
      tabId: 1,
      id: "explicit-zero-budget",
    });

    expect(response.error).toMatchObject({ code: VtxErrorCode.TIMEOUT });
    expect(forwarded(agent, "page.navigate")).toHaveLength(0);
  });
});

function forwarded(agent: FakeAgent, action: string): VtxRequest[] {
  return agent.messages.filter((message): message is VtxRequest =>
    typeof message === "object" && message !== null &&
    (message as { type?: unknown }).type === "request" &&
    (message as { action?: unknown }).action === action);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
