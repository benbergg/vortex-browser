import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerJsHandlers } from "../src/handlers/js.js";
import { SERIALIZER_FN_NAME } from "../src/lib/evaluate-serializer.js";

interface NmRequest {
  type: "tool_request"; tool: string; args: Record<string, unknown>; requestId: string; tabId: number;
}
function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

/**
 * 接线测试:证明适配器确实把真源送进了执行通道。
 * 只断言"最终结果对"是不够的——page-side 可能意外成功,让 CDP 分支的缺陷假绿。
 */
describe("CDP 适配器接线", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let sendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    sendCommand = vi.fn().mockResolvedValue({ result: { value: 1 } });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand } as never;
    registerJsHandlers(router, debuggerMgr);
  });
  afterEach(() => vi.unstubAllGlobals());

  // page-side 先报 CSP 拒绝,逼出 CDP 回退
  function forceCspFallback() {
    executeScript.mockResolvedValue([{ result: { error: "EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script" } }]);
  }

  it("sync:CDP 表达式必须包含序列化真源", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluate", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call, "Runtime.evaluate 未被调用").toBeTruthy();
    expect(call![2].expression).toContain(SERIALIZER_FN_NAME);
  });

  it("sync:CDP 不得等待顶层 Promise(与 page-side sync 语义对齐)", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluate", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].awaitPromise).toBe(false);
  });

  it("async:CDP 等待顶层 Promise", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].awaitPromise).toBe(true);
  });

  it("async:CDP 表达式同样包含序列化真源", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].expression).toContain(SERIALIZER_FN_NAME);
  });

  it("显式传 allowUnsafeEvalBlockedByCSP,不依赖实验性默认值", async () => {
    forceCspFallback();
    await router.dispatch(mkReq("js.evaluate", { code: "return 1" }, 42));
    const call = sendCommand.mock.calls.find((c) => c[1] === "Runtime.evaluate");
    expect(call![2].allowUnsafeEvalBlockedByCSP).toBe(true);
  });
});
