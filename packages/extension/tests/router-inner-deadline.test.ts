// 回归锁：router 层统一内层界（2026-08-18 使用日志挖掘）。
//
// 根因：shared/timeout.ts 明写 inner < hub < transport，但 extension/lib/router.ts
// 从不施加内层 deadline，是否有界取决于各 handler 自觉。mouse/capture/content/
// page.waitForExpression 全是裸 await，页面或 CDP 卡住时只能由 hub 30s 兜底，
// 真实原因在跨进程边界处丢失，只剩 "Request X timed out"。
import { describe, it, expect, afterEach, vi } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import type { NmRequest } from "@vortex-browser/shared";

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId?: number): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", ...(tabId != null ? { tabId } : {}) };
}

/** 探针可响应：executeScript 立即返回 */
function chromeAlive(executeScript = vi.fn(async () => [{ result: 1 }])) {
  (globalThis as any).chrome = {
    tabs: { get: async () => ({ id: 1 }) },
    scripting: { executeScript },
  };
  return executeScript;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // doMock 的登记不随 resetModules 清除，漏掉这行会让后续用例静默用上假探针
  vi.doUnmock("../src/lib/liveness-probe.js");
  vi.resetModules();
  delete (globalThis as any).chrome;
});

describe("ActionRouter 内层 deadline", () => {
  it("handler 永不 settle 时在 action 预算内有界失败", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    chromeAlive();
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(String(resp.error?.message)).toMatch(/mouse\.click/);
    expect(String(resp.error?.message)).toMatch(/30000ms budget/);
    expect(resp.error?.context?.extras?.budgetMs).toBe(30_000);
  });

  it("🔴 页面主线程卡死时归因为 page-unresponsive，hint 明说加大 timeout 无用", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1 }) },
      scripting: { executeScript: () => new Promise(() => {}) },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.context?.extras?.liveness).toBe("page-unresponsive");
    expect(String(resp.error?.hint)).toContain("main thread is blocked");
    expect(String(resp.error?.hint)).toContain("vortex_navigate");
    expect(String(resp.error?.hint)).not.toMatch(/increase the timeout/i);
    expect(resp.error?.recoverable).toBe(false);
  });

  it("页面还活着时归因为动作链路未应答，recoverable=true", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    chromeAlive();
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.context?.extras?.liveness).toBe("page-alive");
    expect(String(resp.error?.hint)).toContain("main thread still responds");
    expect(resp.error?.recoverable).toBe(true);
  });

  it("🔴 探针跑不起来时归因为 probe-failed，hint 不得声称页面死活", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1 }) },
      scripting: {
        executeScript: async () => { throw new Error("Cannot access contents of the page"); },
      },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.context?.extras?.liveness).toBe("probe-failed");
    expect(String(resp.error?.hint)).toContain("liveness probe itself could not run");
    expect(String(resp.error?.hint)).toContain("undetermined");
    expect(String(resp.error?.hint)).not.toMatch(/main thread/i);
    expect(resp.error?.recoverable).toBe(true);
  });

  it("🔴 tab 已消失时归因为 tab-gone，recoverable=false", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => { throw new Error("No tab with id: 1"); } },
      scripting: { executeScript: async () => [{ result: 1 }] },
    };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.context?.extras?.liveness).toBe("tab-gone");
    expect(String(resp.error?.hint)).toContain("vortex_tab_create");
    expect(resp.error?.recoverable).toBe(false);
  });

  // TABLESS_ACTIONS / hub GLOBAL_ACTIONS / verify.ts 的嵌套 dispatch 都不带 tabId,
  // 而 probeLiveness 对 tabId==null 是「不需要探」直接返回 page-alive——router 若
  // 照搬就会对一个根本没有 tab 的调用断言页面死活。
  it("🔴 tabless action 超时归因为 probe-failed，不得谎报 page-alive", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    chromeAlive();
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("tab.list", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("tab.list")).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(resp.error?.context?.extras?.liveness).toBe("probe-failed");
    expect(String(resp.error?.hint)).not.toMatch(/main thread/i);
    expect(resp.error?.recoverable).toBe(true);
  });

  it("🔴 探活自己抛错时按 probe-failed 处置，仍返回 TIMEOUT 而非 JS_EXECUTION_ERROR", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    chromeAlive();
    vi.doMock("../src/lib/liveness-probe.js", () => ({
      probeLiveness: async () => { throw new Error("probe blew up"); },
    }));
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", () => new Promise(() => {}));

    let resp: any;
    const p = router.dispatch(mkReq("mouse.click", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    await p;

    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(resp.error?.context?.extras?.liveness).toBe("probe-failed");
  });

  // 订正三：新界最大的自伤是砍掉本来能成功的长调用。真实日志里 js.evaluate 传
  // timeout 的成功调用 max 42545ms，内层必须随调用方抬高。
  it("🔴 调用方传 timeout=45000 时 40s 才 settle 的 js.evaluate 仍成功", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    chromeAlive();
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("js.evaluate", () =>
      new Promise((resolve) => setTimeout(() => resolve({ value: "late" }), 40_000)));

    let resp: any;
    const p = router.dispatch(mkReq("js.evaluate", { timeout: 45_000 }, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(41_000);
    await p;

    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ value: "late" });
  });

  it("🔴 同一个 40s handler 不传 timeout 时被 30000 缺省预算砍掉", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    chromeAlive();
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("js.evaluate", () =>
      new Promise((resolve) => setTimeout(() => resolve({ value: "late" }), 40_000)));

    let resp: any;
    const p = router.dispatch(mkReq("js.evaluate", {}, 1)).then((r) => { resp = r; });
    await vi.advanceTimersByTimeAsync(41_000);
    await p;

    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(String(resp.error?.message)).toMatch(/30000ms budget/);
    // 兼作探针 doMock 泄漏的哨兵：真探针在此必得 page-alive
    expect(resp.error?.context?.extras?.liveness).toBe("page-alive");
  });

  it("🔴 成功路径不探活（executeScript 零调用，避免每次调用多 300ms）", async () => {
    vi.resetModules();
    const executeScript = chromeAlive();
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("mouse.click", async () => ({ ok: true }));

    const resp = await router.dispatch(mkReq("mouse.click", {}, 1));
    expect(resp.result).toEqual({ ok: true });
    expect(executeScript).toHaveBeenCalledTimes(0);
  });

  it("🔴 REGRESSION: 正常返回的 handler 行为完全不变", async () => {
    vi.resetModules();
    (globalThis as any).chrome = { tabs: { get: async () => ({ id: 1 }) } };
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("foo.bar", async () => ({ ok: true, n: 42 }));
    const resp = await router.dispatch(mkReq("foo.bar"));
    expect(resp.result).toEqual({ ok: true, n: 42 });
    expect(resp.error).toBeUndefined();
  });

  it("🔴 REGRESSION: handler 抛 VtxError 时 payload 不被 deadline 包装吞掉", async () => {
    vi.resetModules();
    (globalThis as any).chrome = { tabs: { get: async () => ({ id: 1 }) } };
    const { vtxError } = await import("@vortex-browser/shared");
    const { ActionRouter } = await import("../src/lib/router.js");
    const router = new ActionRouter();
    router.register("dom.click", async () => {
      throw vtxError(VtxErrorCode.ELEMENT_NOT_FOUND, "Element not found: .missing", {
        selector: ".missing",
      });
    });
    const resp = await router.dispatch(mkReq("dom.click"));
    expect(resp.error?.code).toBe(VtxErrorCode.ELEMENT_NOT_FOUND);
    expect(resp.error?.context?.selector).toBe(".missing");
  });
});
