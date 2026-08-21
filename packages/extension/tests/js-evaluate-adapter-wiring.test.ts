import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("page-side sync 适配器接线", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn().mockResolvedValue([{ result: { result: null } }]);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerJsHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("真源以 args 形式送进注入函数,而非在 func 里另写一份", async () => {
    await router.dispatch(mkReq("js.evaluate", { code: "1+1" }, 42));
    const args = executeScript.mock.calls[0][0].args as string[];
    expect(args.some((a) => typeof a === "string" && a.includes(SERIALIZER_FN_NAME))).toBe(true);
  });

  it("注入函数源码里不再存在第二份品牌路由表", async () => {
    await router.dispatch(mkReq("js.evaluate", { code: "1+1" }, 42));
    const src = (executeScript.mock.calls[0][0].func as (...a: unknown[]) => unknown).toString();
    expect(src).not.toMatch(/expandHost/);
  });

  it("剥离模块作用域后仍能跑通并按真源序列化", async () => {
    await router.dispatch(mkReq("js.evaluate", { code: "1+1" }, 42));
    const call = executeScript.mock.calls[0][0];
    const src = (call.func as (...a: unknown[]) => unknown).toString();
    // new Function 在全局作用域重建,看不到模块级标识符——与页面 MAIN world 等价
    const detached = new Function(`return (${src});`)() as (...a: unknown[]) => { result?: unknown };
    const out = detached("new Map([[1,'a']])", ...(call.args as unknown[]).slice(1));
    expect(out.result).toEqual([[1, "a"]]);
  });
});

describe("page-side async 适配器接线", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn().mockResolvedValue([{ result: { result: null } }]);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerJsHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("真源以 args 形式送进 async 注入函数", async () => {
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const args = executeScript.mock.calls[0][0].args as string[];
    expect(args.some((a) => typeof a === "string" && a.includes(SERIALIZER_FN_NAME))).toBe(true);
  });

  it("剥离作用域后:await 顶层再序列化,host object 不再丢失", async () => {
    await router.dispatch(mkReq("js.evaluateAsync", { code: "return 1" }, 42));
    const call = executeScript.mock.calls[0][0];
    const src = (call.func as (...a: unknown[]) => unknown).toString();
    const detached = new Function(`return (${src});`)() as (...a: unknown[]) => Promise<{ result?: unknown }>;
    const rest = (call.args as unknown[]).slice(1);
    expect((await detached("return new Map([[1,'a']])", ...rest)).result).toEqual([[1, "a"]]);
    expect((await detached("return Promise.resolve(7)", ...rest)).result).toBe(7);
    const nested = await detached("return {name:'x', data: Promise.resolve(1)}", ...rest);
    expect(nested.result).toEqual({
      name: "x",
      data: { __vortexUnserializable: "Promise", hint: "await it in your code, e.g. return await expr" },
    });
  });
});

/**
 * 防复发守卫。本次缺陷的成因就是三条路径各写各的,其中一份还是死代码。
 */
describe("单一真源静态守卫", () => {
  const jsSrc = readFileSync(resolve(__dirname, "../src/handlers/js.ts"), "utf-8");

  it("handlers/js.ts 里不存在第二份品牌路由表", () => {
    expect(jsSrc).not.toMatch(/normalizeEvaluateResult|expandHost/);
  });

  it("序列化只从真源模块引入", () => {
    expect(jsSrc).toMatch(/from "\.\.\/lib\/evaluate-serializer\.js"/);
  });

  it("遗留 content.ts 不得重新出现", () => {
    expect(() => readFileSync(resolve(__dirname, "../src/content.ts"), "utf-8")).toThrow();
  });
});
