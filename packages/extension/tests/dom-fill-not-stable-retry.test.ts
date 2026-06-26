/**
 * Author: qingwa
 * Description: BUG-011 N0060 京东评测 B 方案 — vortex_fill 在 NOT_STABLE 时
 *   默认自动 force=true 重试一次, 消除京东 sticky 搜索栏 100% 触发
 *   NOT_STABLE 需手动 force=true 兜底的痛点。
 *
 * 背景 (reports/jd-dogfood-V1/_meta/BUG-011-vortex_fill_force兜底.md):
 *   京东首页 sticky 搜索栏在 transition 中, vortex_fill 触发 NOT_STABLE。
 *   方案 A 已实现 force 参数透传 (commit 3fb0ee3),但用户每次都得显式
 *   force=true。方案 B: 默认 NOT_STABLE → force=true 重试一次, 仅在
 *   二次仍失败时抛错。
 *
 * Why source-level + jsdom:
 *   - handler 集成: NOT_STABLE 重试逻辑在 vortex_fill handler 内,需 mock
 *     waitActionable 抛 NOT_STABLE 一次,验证二次 force=true 透传
 *   - 集成测试不需 chrome extension runtime, jsdom + ActionRouter 即可
 *
 * 关键契约 (4 条):
 *   1. 默认 (无 force): NOT_STABLE → 自动 force=true 重试, 二次成功则不报错
 *   2. 显式 force=true: 直接 force, 一次成功 (无重试)
 *   3. 显式 force=false: 禁用自动重试, NOT_STABLE 立刻抛出 (用户显式禁用)
 *   4. 二次仍 NOT_STABLE: 抛 VtxErrorCode.NOT_STABLE (非 TIMEOUT)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { VtxErrorCode, DomActions, vtxError } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

// Mock waitActionable — 在测试用例内通过 vi.mocked 重写行为
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
  return { type: "tool_request", tool: DomActions.FILL, args, requestId: "r-1" };
}

describe("vortex_fill NOT_STABLE 自动 force=true 重试 (BUG-011 N0060 方案 B)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    // armDialogPolicy / readDialogCapturedAndDisarm 调用 chrome.scripting.executeScript
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    const dom = new JSDOM("<!DOCTYPE html><html><body><input id='kw'/></body></html>");
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as any;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("契约 1: 默认 (无 force) — NOT_STABLE → 自动 force=true 重试, 二次成功不报错", async () => {
    // 第一次: NOT_STABLE; 第二次 (force=true): 成功
    waitActionableMock
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable after 5000ms (last reason: NOT_STABLE)", { selector: "#kw" }))
      .mockResolvedValueOnce({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: "#kw" });

    const resp = await router.dispatch(
      mkReq({ selector: "#kw", value: "iPhone 16" }),
    );

    expect(resp.error).toBeUndefined();
    expect(waitActionableMock).toHaveBeenCalledTimes(2);
    // 第一次: 默认 force=undefined
    expect(waitActionableMock.mock.calls[0][3]).toMatchObject({ force: undefined });
    // 第二次: 自动 force=true
    expect(waitActionableMock.mock.calls[1][3]).toMatchObject({ force: true });
  });

  it("契约 2: 显式 force=true — 直接 force, 一次成功, 不触发重试", async () => {
    waitActionableMock.mockResolvedValueOnce({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: "#kw" });

    const resp = await router.dispatch(
      mkReq({ selector: "#kw", value: "iPhone 16", force: true }),
    );

    expect(resp.error).toBeUndefined();
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
    expect(waitActionableMock.mock.calls[0][3]).toMatchObject({ force: true });
  });

  it("契约 3: 显式 force=false — 禁用自动重试, NOT_STABLE 立刻抛 NOT_STABLE", async () => {
    waitActionableMock.mockRejectedValueOnce(
      vtxError(VtxErrorCode.NOT_STABLE, "Element not stable after 5000ms (last reason: NOT_STABLE)", { selector: "#kw" }),
    );

    const resp = await router.dispatch(
      mkReq({ selector: "#kw", value: "iPhone 16", force: false }),
    );

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_STABLE);
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
  });

  it("契约 4: 二次仍 NOT_STABLE — 抛 VtxErrorCode.NOT_STABLE (非 TIMEOUT)", async () => {
    // 两次都 NOT_STABLE
    waitActionableMock
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable", { selector: "#kw" }))
      .mockRejectedValueOnce(vtxError(VtxErrorCode.NOT_STABLE, "Element not stable", { selector: "#kw" }));

    const resp = await router.dispatch(
      mkReq({ selector: "#kw", value: "iPhone 16" }),
    );

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_STABLE);
    expect(waitActionableMock).toHaveBeenCalledTimes(2);
  });

  it("非 NOT_STABLE 错误 (如 NOT_ATTACHED) — 不触发 force 重试, 直接抛出", async () => {
    // 京东是 sticky bar transition 触发 NOT_STABLE; 元素不存在应该是 NOT_ATTACHED
    // 这种 semantic error 不应被 force 重试"修复"
    waitActionableMock.mockRejectedValueOnce(
      vtxError(VtxErrorCode.NOT_ATTACHED, "Element not attached", { selector: "#kw" }),
    );

    const resp = await router.dispatch(
      mkReq({ selector: "#kw", value: "iPhone 16" }),
    );

    expect(resp.error?.code).toBe(VtxErrorCode.NOT_ATTACHED);
    expect(waitActionableMock).toHaveBeenCalledTimes(1);
  });

  it("value 校验 (INVALID_PARAMS) 仍在 waitActionable 之前 — 重试逻辑不破坏现有契约", async () => {
    const resp = await router.dispatch(
      mkReq({ selector: "#kw", value: { a: 1 } }),
    );

    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(waitActionableMock).not.toHaveBeenCalled();
  });
});
