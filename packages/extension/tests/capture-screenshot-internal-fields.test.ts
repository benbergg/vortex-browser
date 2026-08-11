import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerCaptureHandlers } from "../src/handlers/capture.js";

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "capture.screenshot", args, requestId: "r-1", tabId: 42 };
}

describe("capture screenshot internal-only fields (P0-6)", () => {
  let router: ActionRouter;
  let cdpCalls: Array<{ method: string; params: any }>;
  let debuggerMgr: any;

  beforeEach(() => {
    cdpCalls = [];
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: {
        executeScript: vi.fn()
          // computeFrameClip: 返回 documentElement bounding rect
          .mockResolvedValueOnce([{ result: { result: { x: 0, y: 100, width: 800, height: 400 } } }])
          // queryIframeRectInParent: 返回 iframe offset { x, y }
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
      // Emulation 域没有 enable 命令(真机 -32601),故走 attach。
      // 旧 fake 缺 attach 且把任何 `.enable` 都 resolve 掉,正是
      // deviceScaleFactor=2 一直坏着却假绿的原因(2026-08-11 live 实证)。
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn((_tab, method, params) => {
        cdpCalls.push({ method, params });
        if (method === "Page.captureScreenshot") return Promise.resolve({ data: "BASE64" });
        return Promise.resolve({});
      }),
    };
    router = new ActionRouter();
    registerCaptureHandlers(router, debuggerMgr);
  });

  it("deviceScaleFactor=2 → setDeviceMetricsOverride 前 + clearDeviceMetricsOverride 後 finally", async () => {
    await router.dispatch(mkReq({ format: "jpeg", quality: 70, deviceScaleFactor: 2 }));
    const methods = cdpCalls.map((c) => c.method);
    expect(methods).toEqual(["Emulation.setDeviceMetricsOverride", "Page.captureScreenshot", "Emulation.clearDeviceMetricsOverride"]);
    const setCall = cdpCalls.find((c) => c.method === "Emulation.setDeviceMetricsOverride")!;
    expect(setCall.params.deviceScaleFactor).toBe(2);
  });

  it("captureScreenshot 抛 → 仍調 clearDeviceMetricsOverride (finally 不吞)", async () => {
    debuggerMgr.sendCommand = vi.fn((_tab, method) => {
      cdpCalls.push({ method, params: {} });
      if (method === "Page.captureScreenshot") return Promise.reject(new Error("cdp boom"));
      return Promise.resolve({});
    });
    const resp = await router.dispatch(mkReq({ deviceScaleFactor: 2 }));
    expect(resp.error).toBeDefined();
    expect(resp.error!.message).toMatch(/cdp boom/);
    const methods = cdpCalls.map((c) => c.method);
    expect(methods).toContain("Emulation.clearDeviceMetricsOverride");
  });

  it("frameId=N → computeFrameClip 後 Page.captureScreenshot 帶 clip", async () => {
    await router.dispatch(mkReq({ format: "jpeg", frameId: 7 }));
    const capCall = cdpCalls.find((c) => c.method === "Page.captureScreenshot")!;
    expect(capCall.params.clip).toBeDefined();
    expect(capCall.params.clip.width).toBe(800);
    expect(capCall.params.clip.height).toBe(400);
  });

  it("不傳 deviceScaleFactor → 不觸碰 Emulation domain", async () => {
    await router.dispatch(mkReq({ format: "jpeg", quality: 70 }));
    const methods = cdpCalls.map((c) => c.method);
    expect(methods.some((m) => m.startsWith("Emulation"))).toBe(false);
  });
});
