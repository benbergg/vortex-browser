import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerJsHandlers } from "../src/handlers/js.js";
import { EVALUATE_TIMEOUT_HINT, TIMEOUT_TAB_GONE_HINT } from "@vortex-browser/shared";

/**
 * VORTEX_FEEDBACK v3.4 BUG-003: vortex_evaluate 死循环导致整个 vortex 栈 crash
 * 根因:chrome.scripting.executeScript 无运行期 timeout,死循环拖死 extension SW + server。
 *
 * 修复:evaluate handler 加 timeout 参数(默认 5000ms),超时时 AbortController 取消 client 端等待。
 * 关键:handler 真注入测试,模拟死循环 func,验证 < timeout 时间收到 timeout error。
 *
 * 测试说明:router 不 throw — 把 vtxError 转成 tool_response { error: { code, message } }。
 * 所以测试 expect out.error.code === "TIMEOUT" 而不是 rejects.toThrow。
 */

interface NmRequest {
  type: "tool_request";
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  tabId: number;
}

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

describe("vortex_evaluate timeout 参数 (BUG-003)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let debuggerMgr: any;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
      enableDomain: vi.fn().mockResolvedValue(undefined),
      isAttached: vi.fn().mockReturnValue(false),
      onEvent: vi.fn(),
      offEvent: vi.fn(),
    };
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        get: vi.fn().mockResolvedValue({ id: 42 }),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://x/" },
        ]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerJsHandlers(router, debuggerMgr);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("timeout=100ms 时,死循环 func 触发 < 500ms 内收到 timeout error", async () => {
    // 模拟死循环:executeScript 返回的 Promise 永远不 resolve
    executeScript.mockImplementation(
      () => new Promise(() => {
        // 永不 resolve — 模拟 page-side 死循环
      }),
    );

    const start = Date.now();
    const out = await router.dispatch(
      mkReq("js.evaluate", { code: "while(true){}", timeout: 100 }, 42),
    ) as { error?: { code: string; message: string } };
    const elapsed = Date.now() - start;

    expect(out.error).toBeDefined();
    expect(out.error!.code).toBe("TIMEOUT");
    expect(out.error!.message).toMatch(/timed out/i);
    // 应在 ~100-200ms 内返回,而不是 30s
    // （超时后会补一次活性探测,最多再加 300ms，见下方「页面还活着」用例）
    expect(elapsed).toBeLessThan(800);
  });

  it("不传 timeout 用默认 5000ms (但显式传 200ms 加速测试)", async () => {
    executeScript.mockImplementation(
      () => new Promise(() => {}),
    );

    const start = Date.now();
    const out = await router.dispatch(
      mkReq("js.evaluate", { code: "while(true){}", timeout: 200 }, 42),
    ) as { error?: { code: string; message: string } };
    const elapsed = Date.now() - start;

    expect(out.error?.code).toBe("TIMEOUT");
    // 应在 ~200-300ms 内 timeout（+ 最多 300ms 的超时后活性探测）
    expect(elapsed).toBeLessThan(800);
    expect(elapsed).toBeGreaterThan(150);
  });

  it("timeout 后后续 evaluate 仍正常工作(不拖死 SW 模拟)", async () => {
    let callCount = 0;
    executeScript.mockImplementation((opts: any) => {
      callCount++;
      if (callCount === 1) {
        // 第一次死循环
        return new Promise(() => {});
      }
      // 第二次正常返
      return Promise.resolve([{ result: { result: 42 } }]);
    });

    const out1 = await router.dispatch(
      mkReq("js.evaluate", { code: "while(true){}", timeout: 100 }, 42),
    ) as { error?: { code: string; message: string }; result?: unknown };
    expect(out1.error?.code).toBe("TIMEOUT");

    // 第二次 evaluate 应仍能工作
    const out2 = await router.dispatch(
      mkReq("js.evaluate", { code: "1+1" }, 42),
    ) as { result?: unknown };
    expect(out2.result).toBe(42);
  });

  it("timeout 非整数或越界 抛 INVALID_PARAMS (tool_response.error)", async () => {
    const cases: Array<unknown> = [0, -1, 100000, 1.5];
    for (const bad of cases) {
      const out = await router.dispatch(
        mkReq("js.evaluate", { code: "1", timeout: bad }, 42),
      ) as { error?: { code: string; message: string } };
      expect(out.error, `bad timeout=${bad}`).toBeDefined();
      expect(out.error!.code, `bad timeout=${bad}`).toBe("INVALID_PARAMS");
      expect(out.error!.message, `bad timeout=${bad}`).toMatch(/timeout/i);
    }
  });

  it("async evaluate 同样支持 timeout 参数", async () => {
    executeScript.mockImplementation(
      () => new Promise(() => {}),
    );

    const start = Date.now();
    const out = await router.dispatch(
      mkReq("js.evaluateAsync", { code: "while(true){}", timeout: 100 }, 42),
    ) as { error?: { code: string; message: string } };
    const elapsed = Date.now() - start;

    expect(out.error?.code).toBe("TIMEOUT");
    expect(elapsed).toBeLessThan(800);
  });

  // 2026-10-30 一周日志分析：实测 10 次 evaluate 超时里 9 次是 loki 查询类调用、1 次是
  // UI 执行 + sleep 取文本；旧文案却让 agent“set shorter timeout / vortex_navigate 清 tab”，
  // 与这类形态相反。此处锁住新 hint。
  it("超时错误带可执行的 hint（拆任务 / 按需加预算），不再让 agent 缩短超时", async () => {
    // 探针(pageQuery)的 func 是 `() => 1`；页内求值的 func 是用户代码。
    // 让探针秒回（页面还活着），让求值永不 settle（页内 promise 未结束）。
    executeScript.mockImplementation((opts: { func?: unknown }) => {
      const src = String(opts?.func ?? "");
      if (src.includes("=> 1")) return Promise.resolve([{ result: 1 }]);
      return new Promise(() => {});
    });

    const out = await router.dispatch(
      mkReq("js.evaluate", { code: "await fetch('/x')", timeout: 100 }, 42),
    ) as { error?: { code: string; message: string; hint?: string; context?: { extras?: Record<string, unknown> } } };

    expect(out.error?.code).toBe("TIMEOUT");
    const hint = out.error?.hint ?? "";
    expect(hint).toBe(EVALUATE_TIMEOUT_HINT);
    expect(hint).not.toMatch(/set shorter timeout/i);
    expect(out.error?.message).not.toMatch(/set shorter timeout/i);
    expect(out.error?.message).not.toMatch(/vortex_navigate to clear/i);
    // 活性归因落进结构化证据（页面还活着 → 问题在本次调用自身路径）
    expect(out.error?.context?.extras?.liveness).toBe("page-alive");
  });

  it("页面已消失时，超时归因到 tab-gone 而不是笼统 TIMEOUT", async () => {
    (chrome.tabs.get as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error("No tab with id: 42"),
    );
    executeScript.mockImplementation(() => new Promise(() => {}));

    const out = await router.dispatch(
      mkReq("js.evaluate", { code: "await fetch('/x')", timeout: 100 }, 42),
    ) as { error?: { code: string; hint?: string; context?: { extras?: Record<string, unknown> } } };

    expect(out.error?.code).toBe("TIMEOUT");
    expect(out.error?.hint).toBe(TIMEOUT_TAB_GONE_HINT);
    expect(out.error?.context?.extras?.liveness).toBe("tab-gone");
  });
});
