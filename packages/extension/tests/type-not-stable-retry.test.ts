/**
 * Author: qingwa
 * Description: vortex_act type 在 NOT_STABLE 时默认自动 force=true 重试一次,
 *   与 vortex_fill (BUG-011) / vortex_act click 对齐。同一族 gated 原语,
 *   sticky / CSS-transition 容器(京东搜索栏)应有一致的 NOT_STABLE 兜底。
 *
 * 背景: 2026-06-09 京东搜索性能白盒复测发现 TYPE 与 CLICK 同样缺 FILL 的
 *   自动 force 重试 —— NOT_STABLE 时自旋满 timeout 直接抛错。
 *
 * 关键契约 (与 dom-fill-not-stable-retry / click-not-stable-retry 对齐):
 *   1. 默认 (无 force): NOT_STABLE → 自动 force=true 重试, 二次成功不报错
 *   2. 显式 force=true: 一次成功, 无重试
 *   3. 显式 force=false: 禁用自动重试, NOT_STABLE 立刻抛
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
vi.mock("../src/adapter/native.js", () => ({
  pageQuery: vi.fn().mockResolvedValue({ result: { success: true } }),
  mapPageError: vi.fn(),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.TYPE, args, requestId: "r-1" };
}

describe("vortex_act type NOT_STABLE 自动 force=true 重试 (对齐 FILL BUG-011)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as any;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("契约 1: 默认 (无 force) — NOT_STABLE → 自动 force=true 重试, 二次成功不报错", async () => {
    waitActionableMock
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable after 2000ms", { selector: "#kw" }))
      .mockResolvedValueOnce(undefined);

    const resp = await router.dispatch(mkReq({ selector: "#kw", text: "iPhone 16" }));

    expect(resp.error).toBeUndefined();
    expect(waitActionableMock).toHaveBeenCalledTimes(2);
    expect(waitActionableMock.mock.calls[0][3]).toMatchObject({ force: undefined });
    expect(waitActionableMock.mock.calls[1][3]).toMatchObject({ force: true });
  });

  it("契约 2: 显式 force=true — 一次成功, 不触发重试", async () => {
    waitActionableMock.mockResolvedValueOnce(undefined);

    const resp = await router.dispatch(mkReq({ selector: "#kw", text: "iPhone 16", force: true }));

    expect(resp.error).toBeUndefined();
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
    expect(waitActionableMock.mock.calls[0][3]).toMatchObject({ force: true });
  });

  it("契约 3: 显式 force=false — 禁用自动重试, NOT_STABLE 立刻抛", async () => {
    waitActionableMock.mockRejectedValueOnce(
      vtxError(VtxErrorCode.NOT_STABLE, "Element not stable after 2000ms", { selector: "#kw" }),
    );

    const resp = await router.dispatch(mkReq({ selector: "#kw", text: "iPhone 16", force: false }));

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_STABLE);
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
  });

  it("契约 4: 二次仍 NOT_STABLE — 抛 NOT_STABLE (非 TIMEOUT)", async () => {
    waitActionableMock
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable", { selector: "#kw" }))
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable", { selector: "#kw" }));

    const resp = await router.dispatch(mkReq({ selector: "#kw", text: "iPhone 16" }));

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_STABLE);
    expect(waitActionableMock).toHaveBeenCalledTimes(2);
  });

  it("契约 5: 非 NOT_STABLE 错误 (NOT_ATTACHED) — 不重试, 直接抛", async () => {
    waitActionableMock.mockRejectedValueOnce(
      vtxError(VtxErrorCode.NOT_ATTACHED, "Element not attached", { selector: "#kw" }),
    );

    const resp = await router.dispatch(mkReq({ selector: "#kw", text: "iPhone 16" }));

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_ATTACHED);
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
  });
});
