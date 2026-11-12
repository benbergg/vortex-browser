import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { registerContentHandlers } from "../src/handlers/content.js";

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

function stubChromeWithFrames(activeFrames: number[]) {
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue(
        activeFrames.map((id) => ({
          frameId: id,
          parentFrameId: id === 0 ? -1 : 0,
          url: id === 0 ? "https://x/" : `https://x/iframe-${id}`,
        })),
      ),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{ result: { result: "should never run" } }]),
    },
    runtime: {
      getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }),
    },
  });
}

describe("frame detach detection (v0.7.4 dogfood 卡点 #4)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.unstubAllGlobals();
    stubChromeWithFrames([]);
    router = new ActionRouter();
    registerObserveHandlers(router);
    registerContentHandlers(router);
  });

  it("observe with stale explicit frameId throws IFRAME_NOT_READY", async () => {
    // Active frames: [0, 99]. Caller asks for frameId=208 (already detached).
    stubChromeWithFrames([0, 99]);
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frameId: 208 }, 42),
    );
    expect(resp.error?.code).toBe("IFRAME_NOT_READY");
    expect(resp.error?.message).toMatch(/Frame 208 is not attached/);
    expect(resp.error?.context?.frameId).toBe(208);
    expect(resp.error?.hint).toMatch(/refresh frame list/);
  });

  it("content.getText with stale explicit frameId throws IFRAME_NOT_READY", async () => {
    stubChromeWithFrames([0]);
    const resp = await router.dispatch(
      mkReq("content.getText", { frameId: 208 }, 42),
    );
    expect(resp.error?.code).toBe("IFRAME_NOT_READY");
    expect(resp.error?.context?.frameId).toBe(208);
  });

  it("content.getHTML with stale explicit frameId throws IFRAME_NOT_READY", async () => {
    stubChromeWithFrames([0]);
    const resp = await router.dispatch(
      mkReq("content.getHTML", { frameId: 999 }, 42),
    );
    expect(resp.error?.code).toBe("IFRAME_NOT_READY");
  });

  it("does NOT throw when frameId is still attached", async () => {
    stubChromeWithFrames([0, 100]);
    const resp = await router.dispatch(
      mkReq("content.getText", { frameId: 100 }, 42),
    );
    // No frame error; executeScript stub returns "should never run" (proves we
    // got past the validation gate)
    expect(resp.error?.code).not.toBe("IFRAME_NOT_READY");
  });

  it("does NOT validate when frameId is omitted (uses active tab default)", async () => {
    stubChromeWithFrames([0]);
    const resp = await router.dispatch(
      mkReq("content.getText", {}, 42),
    );
    expect(resp.error?.code).not.toBe("IFRAME_NOT_READY");
  });

  it("recoverable hint is set so caller knows to re-observe", async () => {
    stubChromeWithFrames([0]);
    const resp = await router.dispatch(
      mkReq("observe.snapshot", { frameId: 999 }, 42),
    );
    expect(resp.error?.recoverable).toBe(true);
    expect(resp.error?.hint).toContain("vortex_observe");
  });
});
