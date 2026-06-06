import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerJsHandlers } from "../src/handlers/js.js";

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
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
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
    expect(elapsed).toBeLessThan(500);
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
    // 应在 ~200-300ms 内 timeout
    expect(elapsed).toBeLessThan(500);
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
    expect(elapsed).toBeLessThan(500);
  });
});
