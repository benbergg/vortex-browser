import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerTabHandlers } from "../src/handlers/tab.js";

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

describe("tab handlers", () => {
  let router: ActionRouter;
  let tabsUpdate: ReturnType<typeof vi.fn>;
  let tabsRemove: ReturnType<typeof vi.fn>;
  let tabsGet: ReturnType<typeof vi.fn>;
  let tabsQuery: ReturnType<typeof vi.fn>;
  let windowsUpdate: ReturnType<typeof vi.fn>;
  let windowsGetLastFocused: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = new ActionRouter();
    tabsUpdate = vi.fn().mockResolvedValue({
      id: 42,
      url: "https://example.com",
      title: "Example",
      windowId: 1,
    });
    tabsRemove = vi.fn().mockResolvedValue(undefined);
    tabsGet = vi.fn().mockResolvedValue({
      id: 42,
      url: "https://example.com",
      title: "Example",
      active: true,
      windowId: 1,
      status: "complete",
    });
    tabsQuery = vi.fn().mockResolvedValue([]);
    windowsUpdate = vi.fn().mockResolvedValue({});
    windowsGetLastFocused = vi.fn().mockResolvedValue({ id: 1 });

    vi.stubGlobal("chrome", {
      tabs: {
        query: tabsQuery,
        create: vi.fn(),
        update: tabsUpdate,
        remove: tabsRemove,
        get: tabsGet,
      },
      windows: {
        update: windowsUpdate,
        getLastFocused: windowsGetLastFocused,
      },
    });
    registerTabHandlers(router);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("tab.list current-window annotation", () => {
    it("marks tabs from the last-focused window and preserves existing fields", async () => {
      const tabs = [
        {
          id: 11,
          url: "https://background.test",
          title: "Background",
          active: true,
          windowId: 1,
          index: 3,
          pinned: false,
          status: "complete",
        },
        {
          id: 12,
          url: "https://focused.test",
          title: "Focused",
          active: true,
          windowId: 2,
          index: 4,
          pinned: true,
          status: "loading",
        },
      ];
      tabsQuery.mockResolvedValueOnce(tabs);
      windowsGetLastFocused.mockResolvedValueOnce({ id: 2 });

      const resp = await router.dispatch(mkReq("tab.list"));

      expect(resp.error).toBeUndefined();
      expect(tabsQuery).toHaveBeenCalledWith({});
      expect(windowsGetLastFocused).toHaveBeenCalledTimes(1);
      expect(resp.result).toEqual([
        { ...tabs[0], lastFocused: false },
        { ...tabs[1], lastFocused: true },
      ]);
    });
  });

  describe("tab.activate (F11 regression)", () => {
    it("🔴 F11: accepts tabId from VtxRequest top-level when args.tabId missing", async () => {
      const resp = await router.dispatch(mkReq("tab.activate", {}, 42));
      expect(resp.error).toBeUndefined();
      expect(tabsUpdate).toHaveBeenCalledWith(42, { active: true });
      expect(windowsUpdate).toHaveBeenCalledWith(1, { focused: true });
    });

    it("accepts tabId from args (legacy path)", async () => {
      const resp = await router.dispatch(mkReq("tab.activate", { tabId: 99 }));
      expect(resp.error).toBeUndefined();
      expect(tabsUpdate).toHaveBeenCalledWith(99, { active: true });
    });

    it("args.tabId takes precedence over top-level tabId", async () => {
      const resp = await router.dispatch(mkReq("tab.activate", { tabId: 99 }, 42));
      expect(resp.error).toBeUndefined();
      expect(tabsUpdate).toHaveBeenCalledWith(99, { active: true });
    });

    it("returns INVALID_PARAMS when neither source provides tabId", async () => {
      const resp = await router.dispatch(mkReq("tab.activate", {}));
      expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
      expect(tabsUpdate).not.toHaveBeenCalled();
    });

    it("does not call windows.update when tab has no windowId", async () => {
      tabsUpdate.mockResolvedValueOnce({
        id: 42,
        url: "x",
        title: "y",
        windowId: undefined,
      });
      await router.dispatch(mkReq("tab.activate", {}, 42));
      expect(windowsUpdate).not.toHaveBeenCalled();
    });
  });

  describe("tab.close (sanity: already correct)", () => {
    it("accepts tabId from top-level", async () => {
      const resp = await router.dispatch(mkReq("tab.close", {}, 42));
      expect(resp.result).toEqual({ success: true });
      expect(tabsRemove).toHaveBeenCalledWith(42);
    });

    it("accepts tabId from args", async () => {
      await router.dispatch(mkReq("tab.close", { tabId: 99 }));
      expect(tabsRemove).toHaveBeenCalledWith(99);
    });
  });

  describe("tab.getInfo (sanity: already correct)", () => {
    it("accepts tabId from top-level", async () => {
      const resp = await router.dispatch(mkReq("tab.getInfo", {}, 42));
      expect(resp.result).toMatchObject({ id: 42 });
    });
  });
});
