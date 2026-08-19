import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";

/**
 * Tests for PageActions.WAIT_FOR_EXPRESSION (`page.waitForExpression`)
 *
 * Handler runs the caller-supplied JS expression via chrome.scripting.executeScript
 * with a page-side promise that polls (RAF + setTimeout) until truthy or timeout.
 * Tests stub executeScript and assert the dispatcher correctly forwards
 * expression / timeout / pollInterval, and that the handler maps the page-side
 * envelope to either a successful return value or a TIMEOUT VtxError.
 */
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

function makeDebuggerMock() {
  return {
    mgr: {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      offEvent: vi.fn(),
      sendCommand: vi.fn(),
      attach: vi.fn().mockResolvedValue(undefined),
      isAttached: vi.fn().mockReturnValue(true),
    } as any,
  };
}

describe("page.waitForExpression (@since 0.8.x)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerPageHandlers(router, makeDebuggerMock().mgr);
  });

  it("returns { ready: true, value, waitedMs } when page-side resolves truthy", async () => {
    executeScript.mockResolvedValue([
      { result: { ok: true, value: 42, waitedMs: 120 } },
    ]);
    const resp = await router.dispatch(
      mkReq("page.waitForExpression", { expression: "window.__READY", timeout: 5000 }, 42),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ ready: true, value: 42, waitedMs: 120 });
  });

  it("forwards expression / timeout / pollInterval to the page-side function args", async () => {
    executeScript.mockResolvedValue([
      { result: { ok: true, value: true, waitedMs: 10 } },
    ]);
    await router.dispatch(
      mkReq("page.waitForExpression", {
        expression: "document.body._x_dataStack && _x_dataStack.length > 0",
        timeout: 8000,
        pollInterval: 50,
      }, 42),
    );
    const call = executeScript.mock.calls[0][0];
    expect(call.args).toEqual([
      "document.body._x_dataStack && _x_dataStack.length > 0",
      8000,
      50,
    ]);
    expect(call.world).toBe("MAIN");
  });

  it("returns INVALID_PARAMS error when expression is missing", async () => {
    const resp = await router.dispatch(mkReq("page.waitForExpression", {}, 42));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });

  it("returns TIMEOUT with expression + waitedMs in context.extras when page-side gives up", async () => {
    executeScript.mockResolvedValue([
      { result: { ok: false, waitedMs: 5000 } },
    ]);
    const resp = await router.dispatch(
      mkReq("page.waitForExpression", { expression: "window.NEVER", timeout: 5000 }, 42),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(resp.error?.context?.extras).toMatchObject({
      expression: "window.NEVER",
      waitedMs: 5000,
    });
  });

  it("propagates the last page-side exception into the TIMEOUT message + extras", async () => {
    executeScript.mockResolvedValue([
      { result: { ok: false, waitedMs: 5000, error: "ReferenceError: foo is not defined" } },
    ]);
    const resp = await router.dispatch(
      mkReq("page.waitForExpression", { expression: "foo.bar", timeout: 5000 }, 42),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(resp.error?.message).toMatch(/ReferenceError: foo is not defined/);
    expect(resp.error?.context?.extras).toMatchObject({
      lastError: "ReferenceError: foo is not defined",
    });
  });

  it("uses default timeout 10000ms and pollInterval 100ms when caller omits them", async () => {
    executeScript.mockResolvedValue([
      { result: { ok: true, value: 1, waitedMs: 1 } },
    ]);
    await router.dispatch(
      mkReq("page.waitForExpression", { expression: "true" }, 42),
    );
    const call = executeScript.mock.calls[0][0];
    expect(call.args).toEqual(["true", 10_000, 100]);
  });

  it("超出内层硬上限的 timeout 直接拒绝，不让 router 抢走语义化消息", async () => {
    const resp: any = await router.dispatch(
      mkReq("page.waitForExpression", { expression: "true", timeout: 100_000 }, 42),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(String(resp.error?.message)).toMatch(/timeout must be an integer in \[1, 60000\]; got 100000/);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("页面主线程卡死时由 SW 侧计时器在调用方 timeout 到点返回", async () => {
    vi.useFakeTimers();
    try {
      // executeScript 永不 settle：page-side poll 排不上队（当日 wait_for 20147ms 的形态）
      executeScript.mockImplementation(() => new Promise(() => {}));
      let resp: any;
      const p = router
        .dispatch(mkReq("page.waitForExpression", { expression: "window.__never === true", timeout: 15_000 }, 42))
        .then((r) => { resp = r; });
      await vi.advanceTimersByTimeAsync(15_500);
      await p;

      expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
      expect(String(resp.error?.message)).toMatch(/within 15000ms/);
      expect(String(resp.error?.message)).toMatch(/page-side polling did not report back/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("page-side 在自身 timeout 到点报活着的语义化结果时，SW margin 让其先手", async () => {
    vi.useFakeTimers();
    try {
      // 模拟页面仍活着：page-side poll 在自身 15000ms timeoutMs 到点报 ok:false（非卡死）
      executeScript.mockImplementation(
        () => new Promise((resolve) => {
          setTimeout(() => resolve([{ result: { ok: false, waitedMs: 15_000, error: "boom" } }]), 15_000);
        }),
      );
      let resp: any;
      const p = router
        .dispatch(mkReq("page.waitForExpression", { expression: "window.__x", timeout: 15_000 }, 42))
        .then((r) => { resp = r; });
      await vi.advanceTimersByTimeAsync(15_000);
      await p;

      expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
      expect(String(resp.error?.message)).toMatch(/last evaluation threw: boom/);
      expect(String(resp.error?.message)).not.toMatch(/page-side polling did not report back/);
    } finally {
      vi.useRealTimers();
    }
  });
});
