import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";

/**
 * P1 flag-自适应:server 注入 args.trustedMode。trustedMode=true 时 CLICK 默认走
 * CDP trusted(cdpClickElement),不发合成 click;false/缺失时保持现状(合成 + #37
 * submit-intent)。useRealMouse 既有路径不退化。
 */
vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockImplementation((_t: unknown, _f: unknown, sel: string) =>
    Promise.resolve({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: sel })),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/cdp.js", () => ({
  cdpClickElement: vi.fn(),
  clickBBox: vi.fn(),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" };
}

describe("CLICK trustedMode 路由(P1)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let cdpClickElement: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const cdp = await import("../src/adapter/cdp.js");
    cdpClickElement = vi.mocked(cdp.cdpClickElement as any);
    const debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue(undefined) } as any;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("trustedMode:true → 走 cdpClickElement,不发合成(executeScript 不被调)", async () => {
    cdpClickElement.mockResolvedValue({ success: true, mode: "realMouse" });
    const resp = await router.dispatch(mkReq({ selector: "button#s", action: "click", trustedMode: true, tabId: 42 }));
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });

  it("trustedMode:false → 现状合成路径(executeScript 被调,cdpClickElement 不被直接走)", async () => {
    executeScript.mockResolvedValue([{ result: { result: { success: true, element: { tag: "div" } } } }]);
    const resp = await router.dispatch(mkReq({ selector: "div.card", action: "click", trustedMode: false, tabId: 42 }));
    expect(executeScript).toHaveBeenCalled();
    expect(cdpClickElement).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ success: true });
  });

  it("trustedMode 缺失 → 同 false(向后兼容)", async () => {
    executeScript.mockResolvedValue([{ result: { result: { success: true, element: { tag: "div" } } } }]);
    const resp = await router.dispatch(mkReq({ selector: "div.card", action: "click", tabId: 42 }));
    expect(executeScript).toHaveBeenCalled();
    expect(cdpClickElement).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ success: true });
  });

  it("useRealMouse:true 仍走 CDP(不退化)", async () => {
    cdpClickElement.mockResolvedValue({ success: true, mode: "realMouse" });
    const resp = await router.dispatch(mkReq({ selector: "button#s", action: "click", useRealMouse: true, tabId: 42 }));
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });
});
