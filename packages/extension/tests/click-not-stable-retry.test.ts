/**
 * Author: qingwa
 * Description: vortex_act click 在 NOT_STABLE 时默认自动 force=true 重试一次,
 *   与 vortex_fill (BUG-011 N0060 方案 B) 对齐。消除京东 sticky 搜索按钮
 *   100% 触发 NOT_STABLE 需手动 force=true / useRealMouse=true 兜底的痛点。
 *
 * 背景 (2026-06-09 京东首页搜索性能白盒复测):
 *   直连 vortex-server (绕开 Claude harness) 实测: 京东搜索按钮 dom.click
 *   在 sticky/CSS-transition 容器内 100% 触发 NOT_STABLE, 自旋满 timeout
 *   后直接抛错 (CLICK 无 FILL 的自动 force 重试)。加 force+useRealMouse 后
 *   183ms 完成。本测试驱动 CLICK 复用 FILL 的自动重试契约。
 *
 * 关键契约 (与 dom-fill-not-stable-retry 对齐):
 *   1. 默认 (无 force): NOT_STABLE → 自动 force=true 重试, 二次成功不报错
 *   2. 显式 force=true: 一次成功, 无重试
 *   3. 显式 force=false: 禁用自动重试, NOT_STABLE 立刻抛出
 *   4. 二次仍 NOT_STABLE: 抛 NOT_STABLE (非 TIMEOUT)
 *   5. 非 NOT_STABLE 错误 (NOT_ATTACHED): 不重试, 直接抛
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxErrorCode, DomActions, vtxError } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

const waitActionableMock = vi.fn();
vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: (...args: unknown[]) => waitActionableMock(...args),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/cdp.js", () => ({
  cdpClickElement: vi.fn().mockResolvedValue({ success: true, mode: "realMouse" }),
  clickBBox: vi.fn(),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" };
}

describe("vortex_act click NOT_STABLE 自动 force=true 重试 (对齐 FILL BUG-011)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript: vi.fn() },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as any;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  // 用 useRealMouse:true 路由到 cdpClickElement(已 mock 成功),
  // 把验证聚焦在 waitActionable 的重试契约上。
  it("契约 1: 默认 (无 force) — NOT_STABLE → 自动 force=true 重试, 二次成功不报错", async () => {
    waitActionableMock
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable after 2000ms", { selector: "button#s" }))
      .mockResolvedValueOnce({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: "button#s" });

    const resp = await router.dispatch(mkReq({ selector: "button#s", useRealMouse: true, tabId: 42 }));

    expect(resp.error).toBeUndefined();
    expect(waitActionableMock).toHaveBeenCalledTimes(2);
    expect(waitActionableMock.mock.calls[0][3]).toMatchObject({ force: undefined });
    expect(waitActionableMock.mock.calls[1][3]).toMatchObject({ force: true });
  });

  it("契约 2: 显式 force=true — 一次成功, 不触发重试", async () => {
    waitActionableMock.mockResolvedValueOnce({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: "button#s" });

    const resp = await router.dispatch(mkReq({ selector: "button#s", useRealMouse: true, force: true, tabId: 42 }));

    expect(resp.error).toBeUndefined();
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
    expect(waitActionableMock.mock.calls[0][3]).toMatchObject({ force: true });
  });

  it("契约 3: 显式 force=false — 禁用自动重试, NOT_STABLE 立刻抛", async () => {
    waitActionableMock.mockRejectedValueOnce(
      vtxError(VtxErrorCode.NOT_STABLE, "Element not stable after 2000ms", { selector: "button#s" }),
    );

    const resp = await router.dispatch(mkReq({ selector: "button#s", useRealMouse: true, force: false, tabId: 42 }));

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_STABLE);
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
  });

  it("契约 4: 二次仍 NOT_STABLE — 抛 NOT_STABLE (非 TIMEOUT)", async () => {
    waitActionableMock
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable", { selector: "button#s" }))
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable", { selector: "button#s" }));

    const resp = await router.dispatch(mkReq({ selector: "button#s", useRealMouse: true, tabId: 42 }));

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_STABLE);
    expect(waitActionableMock).toHaveBeenCalledTimes(2);
  });

  it("契约 5: 非 NOT_STABLE 错误 (NOT_ATTACHED) — 不重试, 直接抛", async () => {
    waitActionableMock.mockRejectedValueOnce(
      vtxError(VtxErrorCode.NOT_ATTACHED, "Element not attached", { selector: "button#s" }),
    );

    const resp = await router.dispatch(mkReq({ selector: "button#s", useRealMouse: true, tabId: 42 }));

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_ATTACHED);
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
  });
});
