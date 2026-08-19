/**
 * Author: qingwa
 * Description: CDP 被别的 debugger 占住时,act useRealMouse 降级为合成路径并自陈。
 *
 * 背景(2026-08-18 使用日志):同一 tab 上 200+ 次 evaluate 正常,只有需要 CDP 的
 * act useRealMouse 与 mouse_click 报 CDP_NOT_ATTACHED(常驻 DevTools 占着 debugger),
 * 模型最后只能 tab_create 弃掉这个 tab 重来。合成路径就在同一 handler 内。
 *
 * 降级不能只在 result 里塞个字段:useRealMouse 的存在理由就是要 isTrusted=true 的
 * 事件,悄悄换成合成再返回 success 会造出「派发了、站点忽略了、工具报成功」的假成功。
 * 故降级必须经 withDiagnosis 自陈,并强制带回效果信号做旁证。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { DomActions, VtxErrorCode, vtxError, splitDiagnosis } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";

vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/cdp.js", () => ({
  cdpClickElement: vi.fn(),
  clickBBox: vi.fn(),
}));

const BUSY = vtxError(
  VtxErrorCode.CDP_NOT_ATTACHED,
  "Another debugger is already attached to the tab with id: 42.",
  { tabId: 42 },
  { hint: "Close DevTools on that tab and retry.", recoverable: true },
);

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-degrade" };
}

describe("CLICK useRealMouse 在 CDP 被占时降级为合成路径", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let cdpClickElement: ReturnType<typeof vi.fn>;
  let loadPageSideModule: ReturnType<typeof vi.fn>;
  let deferWhenCdpAvailable = false;

  beforeEach(async () => {
    vi.clearAllMocks();
    deferWhenCdpAvailable = false;
    // 复刻 page-side 两条契约:effect 仅在 observeEffect=true 时回传;
    // submit-intent/react-clickable 只在 cdpAvailable=true 时才 deferToCdp。
    executeScript = vi.fn(async (injection: { args: unknown[] }) => {
      const cdpAvailable = injection.args[1] === true;
      const observeEffect = injection.args[2] === true;
      if (deferWhenCdpAvailable && cdpAvailable) {
        return [{ result: { result: { deferToCdp: true, element: { tag: "button", id: "go" } } } }];
      }
      return [{
        result: {
          result: {
            success: true,
            element: { tag: "button", id: "go" },
            ...(observeEffect ? { effect: { domMutations: 2, urlChanged: false } } : {}),
          },
        },
      }];
    });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const cdp = await import("../src/adapter/cdp.js");
    cdpClickElement = vi.mocked(cdp.cdpClickElement as never);
    const loader = await import("../src/adapter/page-side-loader.js");
    loadPageSideModule = vi.mocked(loader.loadPageSideModule as never);
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as never;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("CDP_NOT_ATTACHED → 走合成路径并标 degraded,不再让调用方弃 tab", async () => {
    cdpClickElement.mockRejectedValue(BUSY);
    const resp = await router.dispatch(
      mkReq({ selector: "button#go", action: "click", useRealMouse: true, tabId: 42 }),
    );
    expect(resp.error).toBeUndefined();
    expect(executeScript).toHaveBeenCalled();
    const { value } = splitDiagnosis(resp.result);
    expect(value).toMatchObject({ success: true, degraded: "cdp-busy-synthetic" });
  });

  it("降级必须自陈:诊断里点明 isTrusted=false 与 DevTools 占用", async () => {
    cdpClickElement.mockRejectedValue(BUSY);
    const resp = await router.dispatch(
      mkReq({ selector: "button#go", action: "click", useRealMouse: true, tabId: 42 }),
    );
    const { diagnosis } = splitDiagnosis(resp.result);
    expect(diagnosis).toBeTruthy();
    expect(diagnosis).toMatch(/isTrusted/);
    expect(diagnosis).toMatch(/DevTools/i);
  });

  it("降级路径强制采效果信号:调用方没开 observeEffect 也带回 effect", async () => {
    cdpClickElement.mockRejectedValue(BUSY);
    const resp = await router.dispatch(
      mkReq({ selector: "button#go", action: "click", useRealMouse: true, tabId: 42 }),
    );
    const { value } = splitDiagnosis(resp.result);
    expect((value as { effect?: unknown }).effect).toEqual({ domMutations: 2, urlChanged: false });
    expect(loadPageSideModule).toHaveBeenCalledWith(42, undefined, "click-effect");
  });

  it("trustedMode 隐式 CDP 同样降级(不是只认显式 useRealMouse)", async () => {
    cdpClickElement.mockRejectedValue(BUSY);
    const resp = await router.dispatch(
      mkReq({ selector: "button#go", action: "click", trustedMode: true, tabId: 42 }),
    );
    const { value } = splitDiagnosis(resp.result);
    expect(value).toMatchObject({ degraded: "cdp-busy-synthetic" });
  });

  it("非 CDP_NOT_ATTACHED 的失败原样抛,不借降级把真错误吞掉", async () => {
    cdpClickElement.mockRejectedValue(
      vtxError(VtxErrorCode.PERMISSION_DENIED, "Cannot access chrome:// URL", { tabId: 42 }),
    );
    const resp = await router.dispatch(
      mkReq({ selector: "button#go", action: "click", useRealMouse: true, tabId: 42 }),
    );
    expect(resp.error?.code).toBe("PERMISSION_DENIED");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("CDP 正常时零污染:无 degraded、无自陈、形状不变", async () => {
    cdpClickElement.mockResolvedValue({
      success: true,
      element: { tag: "button", text: "Go" },
      x: 10,
      y: 20,
      mode: "realMouse",
    });
    const resp = await router.dispatch(
      mkReq({ selector: "button#go", action: "click", useRealMouse: true, tabId: 42 }),
    );
    const { value, diagnosis } = splitDiagnosis(resp.result);
    expect(diagnosis).toBeNull();
    expect(value).toEqual({
      success: true,
      element: { tag: "button", text: "Go" },
      x: 10,
      y: 20,
      mode: "realMouse",
    });
  });

  it("普通合成 click(未走 CDP)不受影响:无 degraded、无自陈、无强制 effect", async () => {
    const resp = await router.dispatch(mkReq({ selector: "div.card", action: "click", tabId: 42 }));
    const { value, diagnosis } = splitDiagnosis(resp.result);
    expect(diagnosis).toBeNull();
    expect(value).toEqual({ success: true, element: { tag: "button", id: "go" } });
    expect(cdpClickElement).not.toHaveBeenCalled();
  });
  it("非「被占」的 attach 失败:自陈不谎称是谁占着,degraded 与 effect 照旧", async () => {
    cdpClickElement.mockRejectedValue(
      vtxError(VtxErrorCode.CDP_NOT_ATTACHED, "Cannot access a chrome:// URL", { tabId: 42 }),
    );
    const resp = await router.dispatch(
      mkReq({ selector: "button#go", action: "click", useRealMouse: true, tabId: 42 }),
    );
    const { value, diagnosis } = splitDiagnosis(resp.result);
    expect(diagnosis).not.toMatch(/DevTools/i);
    expect(diagnosis).not.toMatch(/held by another client/i);
    expect(diagnosis).toMatch(/isTrusted/);
    expect(diagnosis).toContain("Cannot access a chrome:// URL");
    expect(value).toMatchObject({ degraded: "cdp-busy-synthetic" });
    expect((value as { effect?: unknown }).effect).toEqual({ domMutations: 2, urlChanged: false });
  });

  it("deferToCdp 回退合成同样自陈:这条路才是 sequence/默认 click 的常走路", async () => {
    deferWhenCdpAvailable = true;
    cdpClickElement.mockRejectedValue(BUSY);
    const resp = await router.dispatch(mkReq({ selector: "button#go", action: "click", tabId: 42 }));
    const { value, diagnosis } = splitDiagnosis(resp.result);
    expect(diagnosis).toBeTruthy();
    expect(diagnosis).toMatch(/isTrusted/);
    expect(diagnosis).toMatch(/DevTools/i);
    expect(value).toMatchObject({ success: true, degraded: "cdp-busy-synthetic" });
    expect((value as { effect?: unknown }).effect).toEqual({ domMutations: 2, urlChanged: false });
  });

  it("deferToCdp 回退的失败不是 attach 类时不贴降级标签,不谎报", async () => {
    deferWhenCdpAvailable = true;
    cdpClickElement.mockRejectedValue(
      vtxError(VtxErrorCode.ELEMENT_OCCLUDED, "Element button#go is covered by <div>", { tabId: 42 }),
    );
    const resp = await router.dispatch(mkReq({ selector: "button#go", action: "click", tabId: 42 }));
    const { value, diagnosis } = splitDiagnosis(resp.result);
    expect(diagnosis).toBeNull();
    expect(value).toEqual({ success: true, element: { tag: "button", id: "go" } });
  });
});
