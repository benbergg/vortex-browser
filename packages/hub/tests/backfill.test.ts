/**
 * Author: qingwa
 * Description: Verifies hub request tab backfilling and global-action exceptions.
 */
import { describe, expect, it, vi } from "vitest";
import type { VtxRequest, VtxResponse } from "@vortex-browser/shared";
import type { BrowserEntry, SessionEntry } from "../src/registry.js";
import { GLOBAL_ACTIONS, prepareRequest } from "../src/tab-ownership.js";

function session(): SessionEntry {
  return {
    sessionId: "session-a",
    role: "mcp",
    label: "Session A",
    ws: null,
    wireVersion: 2,
    connectedAt: 1,
    lastSeenAt: 1,
    browserId: "browser-a",
    lastBrowserId: "browser-a",
    rebindUntil: 0,
    buffer: [],
    ownedTabs: new Set(),
    currentTabId: null,
    claiming: null,
    browserPref: null,
    strictTab: false,
  };
}

function browser(): BrowserEntry {
  return {
    browserId: "browser-a",
    label: "Browser A",
    ws: undefined,
    peerVersion: "test",
    connectedAt: 1,
    lastSeenAt: 1,
    nmConnected: true,
    sessions: new Set(["session-a"]),
    tabOwner: new Map(),
    opener: new Map(),
  };
}

function response(request: VtxRequest, result: unknown): VtxResponse {
  return { action: request.action, id: request.id, result };
}

describe("prepareRequest", () => {
  it("leaves every global action unchanged and never calls the tab resolver", async () => {
    const s = session();
    const b = browser();
    const call = vi.fn<[(request: VtxRequest) => Promise<VtxResponse>]>().mockRejectedValue(new Error("not called"));

    for (const action of GLOBAL_ACTIONS) {
      const request: VtxRequest = { action, id: `request-${action}` };
      await expect(prepareRequest(s, b, request, call)).resolves.toBe(request);
    }

    expect(call).not.toHaveBeenCalled();
  });

  it("leaves an explicit tabId untouched", async () => {
    const s = session();
    const b = browser();
    const call = vi.fn<[(request: VtxRequest) => Promise<VtxResponse>]>().mockRejectedValue(new Error("not called"));
    const request: VtxRequest = { action: "page.navigate", id: "explicit", tabId: 42 };

    await expect(prepareRequest(s, b, request, call)).resolves.toBe(request);
    expect(call).not.toHaveBeenCalled();
  });

  it("backfills every other action with the claimed current tab", async () => {
    const s = session();
    const b = browser();
    const call = vi.fn(async (request: VtxRequest) =>
      response(request, [{ id: 7, url: "https://target.test", title: "Target", active: true }]));
    const request: VtxRequest = { action: "page.navigate", id: "backfilled" };

    const prepared = await prepareRequest(s, b, request, call);

    expect(prepared).toEqual({ ...request, tabId: 7, tabIdBackfilled: true });
    expect(s.currentTabId).toBe(7);
    expect(b.tabOwner.get(7)).toBe("session-a");
  });
});
