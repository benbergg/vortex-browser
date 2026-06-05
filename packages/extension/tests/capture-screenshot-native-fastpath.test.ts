import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerCaptureHandlers } from "../src/handlers/capture.js";

// P0 截图提速:viewport 截图(非 fullPage/clip/单 frame/DPR override)走 native
// chrome.tabs.captureVisibleTab(~10-50ms),绕开 CDP attach 的 ~3s 开销 + 黄条。
// captureVisibleTab 仅能截「窗口当前活跃 tab 的可见区」,故须确认目标 tab 活跃;
// 否则(非活跃 / fullPage / clip / 单 frame / DPR / native 失败)回退 CDP。

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "capture.screenshot", args, requestId: "r-1", tabId: 42 };
}

describe("capture screenshot native fast-path (P0)", () => {
  let router: ActionRouter;
  let cdpCalls: Array<{ method: string; params: any }>;
  let captureVisibleTab: ReturnType<typeof vi.fn>;
  let tabsGet: ReturnType<typeof vi.fn>;
  let debuggerMgr: any;

  function setup(tabOverrides: Record<string, unknown> = {}) {
    cdpCalls = [];
    captureVisibleTab = vi.fn().mockResolvedValue("data:image/png;base64,NATIVE");
    tabsGet = vi.fn().mockResolvedValue({ id: 42, active: true, windowId: 11, ...tabOverrides });
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        get: tabsGet,
        captureVisibleTab,
      },
      scripting: {
        executeScript: vi.fn()
          .mockResolvedValueOnce([{ result: { result: { x: 0, y: 100, width: 800, height: 400 } } }])
          .mockResolvedValue([{ result: { x: 0, y: 0 } }]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://example.com/" },
          { frameId: 7, parentFrameId: 0, url: "https://example.com/frame" },
        ]),
      },
    });
    debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn((_tab, method, params) => {
        cdpCalls.push({ method, params });
        if (method === "Page.captureScreenshot") return Promise.resolve({ data: "CDP" });
        if (method === "Page.getLayoutMetrics") return Promise.resolve({ cssContentSize: { width: 800, height: 1200 } });
        return Promise.resolve({});
      }),
    };
    router = new ActionRouter();
    registerCaptureHandlers(router, debuggerMgr);
  }

  beforeEach(() => setup());

  it("默认 viewport 截图(活跃 tab)→ 走 captureVisibleTab,完全不碰 CDP", async () => {
    const resp = await router.dispatch(mkReq({ format: "png" }));
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(cdpCalls).toHaveLength(0);
    expect(debuggerMgr.enableDomain).not.toHaveBeenCalled();
    const data = resp.result as any;
    expect(data.dataUrl).toBe("data:image/png;base64,NATIVE");
    expect(data.format).toBe("png");
    expect(data.fullPage).toBe(false);
    expect(typeof data.timestamp).toBe("number");
  });

  it("native 路径传正确 windowId + jpeg quality", async () => {
    await router.dispatch(mkReq({ format: "jpeg", quality: 70 }));
    expect(captureVisibleTab).toHaveBeenCalledWith(11, { format: "jpeg", quality: 70 });
  });

  it("png 不带 quality 字段", async () => {
    await router.dispatch(mkReq({ format: "png" }));
    expect(captureVisibleTab).toHaveBeenCalledWith(11, { format: "png" });
  });

  it("png + quality → native 丢弃 quality(quality 仅 jpeg 有意义)", async () => {
    await router.dispatch(mkReq({ format: "png", quality: 70 }));
    expect(captureVisibleTab).toHaveBeenCalledWith(11, { format: "png" });
  });

  it("frameId=0(顶 frame)→ 仍走 native,不碰 CDP", async () => {
    await router.dispatch(mkReq({ frameId: 0 }));
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(cdpCalls).toHaveLength(0);
  });

  it("windowId 无效(-1)→ 跳过 native 回退 CDP", async () => {
    setup({ windowId: -1 });
    await router.dispatch(mkReq({ format: "png" }));
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(cdpCalls.some((c) => c.method === "Page.captureScreenshot")).toBe(true);
  });

  it("fullPage:true → 走 CDP,不调 captureVisibleTab", async () => {
    await router.dispatch(mkReq({ fullPage: true }));
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(cdpCalls.some((c) => c.method === "Page.captureScreenshot")).toBe(true);
  });

  it("clip → 走 CDP", async () => {
    await router.dispatch(mkReq({ clip: { x: 0, y: 0, width: 100, height: 100 } }));
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(cdpCalls.some((c) => c.method === "Page.captureScreenshot")).toBe(true);
  });

  it("frameId=7 → 走 CDP", async () => {
    await router.dispatch(mkReq({ frameId: 7 }));
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(cdpCalls.some((c) => c.method === "Page.captureScreenshot")).toBe(true);
  });

  it("deviceScaleFactor=2 → 走 CDP", async () => {
    await router.dispatch(mkReq({ deviceScaleFactor: 2 }));
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(cdpCalls.some((c) => c.method === "Emulation.setDeviceMetricsOverride")).toBe(true);
  });

  it("目标 tab 非活跃 → 回退 CDP,且返回 shape 与 CDP 路径一致", async () => {
    setup({ active: false });
    const resp = await router.dispatch(mkReq({ format: "png" }));
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(cdpCalls.some((c) => c.method === "Page.captureScreenshot")).toBe(true);
    const data = resp.result as any;
    expect(data.dataUrl).toBe("data:image/png;base64,CDP");
    expect(data.format).toBe("png");
    expect(data.fullPage).toBe(false);
    expect(typeof data.timestamp).toBe("number");
  });

  it("captureVisibleTab 抛错 → 回退 CDP(safety net),返回完整 CDP shape", async () => {
    captureVisibleTab.mockRejectedValue(new Error("Cannot capture restricted page"));
    const resp = await router.dispatch(mkReq({ format: "png" }));
    expect(cdpCalls.some((c) => c.method === "Page.captureScreenshot")).toBe(true);
    const data = resp.result as any;
    expect(data.dataUrl).toBe("data:image/png;base64,CDP");
    expect(data.format).toBe("png");
    expect(data.fullPage).toBe(false);
    expect(typeof data.timestamp).toBe("number");
  });
});
