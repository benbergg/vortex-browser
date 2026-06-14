import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerJsHandlers } from "../src/handlers/js.js";

/**
 * 真实站 dogfood(2026-06-02 github.com round 11)发现:页面 CSP 禁 `unsafe-eval`
 * (GitHub / Twitter / Shopify / 多数银行 SaaS 普遍)时,vortex_evaluate 注入 func 内
 * 的 eval / new Function 被**直接拒绝**——这与 Trusted Types 是两套独立机制,命名
 * policy 救不了(eval 本身不被允许)。observe/act 走 executeScript({func}) 不受影响,
 * 唯 evaluate 失效。
 *
 * 修复:eval 报 unsafe-eval 时回退 CDP Runtime.evaluate(debugger 级求值绕过页面
 * CSP,与 Playwright 同路)。仅主 frame;只 attach 不 enable domain,求值后
 * detachIfNoDomains 移除横幅(不误伤已 enable domain 的 Network/Console)。
 *
 * 测试面:host 侧逻辑——executeScript 返回 unsafe-eval 错误时,断言 handler 调用
 * mock debuggerMgr 的 attach + Runtime.evaluate + detachIfNoDomains 并返回其值。
 */

const UNSAFE_EVAL_MSG =
  "Evaluating a string as JavaScript violates the following Content Security Policy " +
  "directive because 'unsafe-eval' is not an allowed source of script";

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

/** dispatch 返回 {result} 或 {error:{code,message}} 信封。 */
type Resp = { result?: unknown; error?: { code: string; message: string } };

interface MockDebuggerMgr {
  attach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
}

describe("js.evaluate CSP unsafe-eval → CDP Runtime.evaluate 回退 (github dogfood 2026-06-02)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let dbg: MockDebuggerMgr;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://github.com/" },
          { frameId: 3, parentFrameId: 0, url: "https://github.com/sub" },
        ]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    dbg = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(),
    };
    registerJsHandlers(router, dbg as unknown as Parameters<typeof registerJsHandlers>[1]);
  });

  it("eval 报 unsafe-eval 时,回退 CDP Runtime.evaluate 并返回其值", async () => {
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand.mockResolvedValue({ result: { value: 42 } });

    const out = (await router.dispatch(mkReq("js.evaluate", { code: "40 + 2" }))) as Resp;
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(42);
    // attach → Runtime.evaluate(returnByValue/awaitPromise) → detach 横幅。
    expect(dbg.attach).toHaveBeenCalledWith(42);
    expect(dbg.sendCommand).toHaveBeenCalledWith(
      42,
      "Runtime.evaluate",
      expect.objectContaining({ expression: "40 + 2", returnByValue: true, awaitPromise: true }),
    );
  });

  it("CDP Runtime.evaluate 的 timeout 必须是 number 毫秒(真实 CDP 契约,非 boolean)", async () => {
    // 真实站 dogfood 2026-06-14:CDP `Runtime.evaluate.timeout` 是 TimeDelta(number, ms)。
    // 旧实现(b156687)传 `timeout: true` + 自造 `timeoutMs` 字段 → 真 CDP 报
    // "Failed to deserialize params.timeout - double value expected",CSP 站 evaluate 100% 崩。
    // mock 不校验真实 CDP 语义,objectContaining 又没断言 timeout,故旧 bug 一路绿灯。
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand.mockResolvedValue({ result: { value: 1 } });

    await router.dispatch(mkReq("js.evaluate", { code: "1", timeout: 4321 }));

    const params = dbg.sendCommand.mock.calls[0][2] as Record<string, unknown>;
    // timeout 必须是真实毫秒数(CDP 期望 double),不能是 boolean true
    expect(typeof params.timeout).toBe("number");
    // CDP native timeout = 请求 timeout + 渲染器强杀 backstop(2000ms);客户端 withTimeout
    // 才是主超时(见下方两测试),CDP native 仅作同步死循环的渲染器兜底强杀、设长一点确保
    // 客户端计时器先触发→干净 TIMEOUT,-32603 永不抢先。
    expect(params.timeout).toBe(4321 + 2000);
    // 不得带 CDP 不认识的自造字段 timeoutMs
    expect(params).not.toHaveProperty("timeoutMs");
  });

  it("CDP 回退 evaluate sendCommand 不 settle(同步死循环阻塞 / 异步 pending)→ 干净 TIMEOUT", async () => {
    // 真实站 dogfood 2026-06-14:CDP `Runtime.evaluate.timeout` 只终止**同步**执行,不覆盖
    // awaitPromise 的异步等待(live:setTimeout(10s) 在 timeout=1.5s 下不被 CDP 中止 → 挂死
    // 到 MCP 层 "no response");且同步死循环被 CDP 终止时以泛化 -32603 reject、isTimeoutError
    // 抓不到。修:cdpEvaluate 用客户端 withTimeout(SW 计时器独立于被阻塞渲染器)统一兜底。
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand.mockReturnValue(new Promise(() => {})); // 永不 settle
    const out = (await router.dispatch(
      mkReq("js.evaluate", { code: "while(1){}", timeout: 80 }),
    )) as Resp;
    expect(out.error?.code).toBe("TIMEOUT");
    expect(out.error?.message).toMatch(/timed out/i);
  }, 3000);

  it("CDP 回退 evaluate 早于超时的真错(reject)→ JS_EXECUTION_ERROR,不误判 TIMEOUT", async () => {
    // 守卫:detached target / 协议错等会**立即** reject(elapsed << timeout),不得被当超时。
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand.mockRejectedValue(new Error("Target closed unexpectedly"));
    const out = (await router.dispatch(
      mkReq("js.evaluate", { code: "1", timeout: 5000 }),
    )) as Resp;
    expect(out.error?.code).toBe("JS_EXECUTION_ERROR");
    expect(out.error?.message).toMatch(/Target closed/);
  });

  it("不主动 detach(与 bare-attach mouse/dom 一致,避免误 detach 对方在途会话)", async () => {
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand.mockResolvedValue({ result: { value: 1 } });
    await router.dispatch(mkReq("js.evaluate", { code: "1" }));
    // 不应存在 detach 调用(保持 attach,横幅与 Input.* CDP 路径同样常驻)。
    expect((dbg as Record<string, unknown>).detachIfNoDomains).toBeUndefined();
    expect((dbg as Record<string, unknown>).detach).toBeUndefined();
  });

  it("CDP 下 top-level return 非法 → auto-IIFE 包装重试", async () => {
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand
      .mockResolvedValueOnce({
        exceptionDetails: { exception: { description: "SyntaxError: Illegal return statement" } },
      })
      .mockResolvedValueOnce({ result: { value: 7 } });

    const out = (await router.dispatch(mkReq("js.evaluate", { code: "return 3 + 4" }))) as Resp;
    expect(out.result).toBe(7);
    expect(dbg.sendCommand).toHaveBeenCalledTimes(2);
    // 第二次用 (function(){...})() 包装。
    expect(dbg.sendCommand.mock.calls[1][2]).toMatchObject({
      expression: "(function(){return 3 + 4})()",
    });
  });

  it("CDP Runtime.evaluate 真异常(非 return)→ 包成 JS_EXECUTION_ERROR 抛出", async () => {
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand.mockResolvedValue({
      exceptionDetails: { exception: { description: "ReferenceError: foo is not defined" } },
    });
    const out = (await router.dispatch(mkReq("js.evaluate", { code: "foo" }))) as Resp;
    expect(out.error?.message).toMatch(/foo is not defined/);
  });

  it("非 unsafe-eval 错误**不**触发 CDP 回退,抛原错", async () => {
    executeScript.mockResolvedValue([{ result: { error: "TypeError: x is not a function" } }]);
    const out = (await router.dispatch(mkReq("js.evaluate", { code: "x()" }))) as Resp;
    expect(out.error?.message).toMatch(/x is not a function/);
    expect(dbg.attach).not.toHaveBeenCalled();
  });

  it("子 frame(frameId != null)不走 CDP 回退(暂不支持),抛原 unsafe-eval 错", async () => {
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    const out = (await router.dispatch(
      mkReq("js.evaluate", { code: "1+1", frameId: 3 }),
    )) as Resp;
    expect(out.error?.message).toMatch(/unsafe-eval/);
    expect(dbg.attach).not.toHaveBeenCalled();
  });

  it("js.evaluateAsync 报 unsafe-eval + 表达式 code 时,回退 CDP 用 expr-first 包装 + awaitPromise", async () => {
    // B3-4 v3.3 (V2):CDP 回退改 expr-first,表达式 code 直接走 expr 形式。
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand.mockResolvedValue({ result: { value: 99 } });

    const out = (await router.dispatch(mkReq("js.evaluateAsync", { code: "Promise.resolve(99)" }))) as Resp;
    expect(out.result).toBe(99);
    expect(dbg.sendCommand.mock.calls[0][2]).toMatchObject({
      expression: "(async () => (Promise.resolve(99)))()",
      awaitPromise: true,
    });
  });

  it("js.evaluateAsync 报 unsafe-eval + 语句 code 时,CDP expr-first 失败回退到函数体 IIFE", async () => {
    // B3-4 v3.3 (V2):语句型 code 的 CDP 回退:expr-first 失败 → 第二次重试函数体 IIFE。
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    dbg.sendCommand
      .mockRejectedValueOnce(new Error("SyntaxError: Unexpected token 'return'"))
      .mockResolvedValueOnce({ result: { value: 99 } });

    const out = (await router.dispatch(mkReq("js.evaluateAsync", { code: "return 99" }))) as Resp;
    expect(out.result).toBe(99);
    // 第一次 sendCommand 用 expr-first(失败);第二次用函数体 IIFE(成功)
    expect(dbg.sendCommand.mock.calls[0][2]).toMatchObject({
      expression: "(async () => (return 99))()",
      awaitPromise: true,
    });
    expect(dbg.sendCommand.mock.calls[1][2]).toMatchObject({
      expression: "(async () => { return 99 })()",
      awaitPromise: true,
    });
  });

  it("无 debuggerMgr 时(未注入)不回退,抛原错(向后兼容)", async () => {
    const r2 = new ActionRouter();
    registerJsHandlers(r2); // 不传 debuggerMgr
    executeScript.mockResolvedValue([{ result: { error: UNSAFE_EVAL_MSG } }]);
    const out = (await r2.dispatch(mkReq("js.evaluate", { code: "1+1" }))) as Resp;
    expect(out.error?.message).toMatch(/unsafe-eval/);
  });
});
