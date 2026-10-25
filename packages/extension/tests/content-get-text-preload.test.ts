/**
 * Author: mcode (MiniMax-M3.1-Flash)
 * Description: GET_TEXT 的 page-side 预加载必须按需——没有 selector 时不注入 dom-resolve。
 *
 * 背景(2026-10-25 近 7 天日志分析):366 次调用里 21 次失败,唯一确认的 Vortex 侧缺陷
 * 是 5 次 PAGE_NOT_READY,**全部**落在"没有 selector 的 vortex_extract"上。根因是
 * content.ts 里 GET_TEXT 无条件 `await loadPageSideModule(..., "dom-resolve")`,
 * 而 files 注入 3s 不 settle 就抛 PAGE_NOT_READY,把一次本可成功的 extract 打断。
 *
 * 注入的 func 只在 sel 非空时才用 `window.__vortexDomResolve.queryDeep(sel)`;
 * sel 为空时 root 取 document.body、open shadow 文本由 collectShadowText 自己遍历
 * el.shadowRoot 拿,**不依赖 dom-resolve 模块** ⇒ 无 selector 时预加载是纯负担。
 *
 * 本文件走真实 dispatch(ActionRouter + registerContentHandlers),只 mock chrome.*,
 * 不用源码正则匹配(改注释就能骗过正则测试)。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";

/** 与 page-side-loader.ts 的 INJECT_TIMEOUT_MS 对齐 */
const INJECT_TIMEOUT_MS = 3000;

type FilesBehavior = "settle" | "hang";

interface Injection {
  target?: { tabId?: number; frameIds?: number[] };
  files?: string[];
  func?: (...args: unknown[]) => unknown;
  args?: unknown[];
  world?: string;
}

interface Setup {
  router: import("../src/lib/router.js").ActionRouter;
  executeScript: Mock;
  setSnapshot: (id: string, entry: {
    tabId: number;
    capturedAt: number;
    frameId?: number;
    elements: Array<{ index: number; selector: string; frameId?: number }>;
  }) => void;
  VtxErrorCode: typeof import("@vortex-browser/shared").VtxErrorCode;
}

/**
 * 每次 setup 都 resetModules + 动态 import:
 * - page-side-loader 的 loadedModules 是模块级缓存(注入成功后同一 tab 不再注入),
 *   重置模块才能让每个用例都从"未注入"状态开始;
 * - 动态 import 保证 router / content / loader / shared 落在同一份模块图里,
 *   `err instanceof VtxError` 才有意义。
 */
async function setup(files: FilesBehavior = "settle"): Promise<Setup> {
  vi.resetModules();

  const executeScript = vi.fn((injection: Injection) => {
    // loader 注入(files):默认 settle;hang 复刻坏 SW/navigation 态下永不 settle
    if (injection?.files) {
      if (files === "hang") return new Promise(() => {});
      return Promise.resolve([{ result: undefined }]);
    }
    // 正文注入(func)
    return Promise.resolve([{ result: { result: "TEXT" } }]);
  });

  (globalThis as any).chrome = {
    scripting: { executeScript },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      get: vi.fn(async () => ({ id: 1 })),
      query: vi.fn(async () => [{ id: 1 }]),
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn() },
      getAllFrames: vi.fn(async () => [{ frameId: 0 }]),
    },
  };

  const { ActionRouter } = await import("../src/lib/router.js");
  const { registerContentHandlers } = await import("../src/handlers/content.js");
  const { setSnapshot } = await import("../src/lib/snapshot-store.js");
  const shared = await import("@vortex-browser/shared");

  const router = new ActionRouter();
  registerContentHandlers(router);
  return { router, executeScript, setSnapshot, VtxErrorCode: shared.VtxErrorCode };
}

function req(args: Record<string, unknown>, requestId = "r1"): NmRequest {
  return { type: "tool_request", tool: "content.getText", args, requestId, tabId: 1 };
}

/** 按注入形状分流 executeScript 调用:files=loader 预加载,func=正文注入 */
function splitCalls(executeScript: Mock): { files: Injection[]; funcs: Injection[] } {
  const calls = executeScript.mock.calls.map((c) => (c[0] ?? {}) as Injection);
  return {
    files: calls.filter((c) => Array.isArray(c.files)),
    funcs: calls.filter((c) => typeof c.func === "function"),
  };
}

/**
 * 让 handler 推进到真正调用 loader(创建 3s 定时器)为止。
 * loader 的定时器在 handler 的第 2 个 await 之后才创建,不预冲刷微任务的话
 * 3000ms 的推进窗口可能落在定时器创建之前,导致超时永远不 fire。
 */
async function flushToLoaderCall(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("content.getText 的 page-side 预加载按需化", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  it("无 selector 时不预加载 dom-resolve,只做一次 func 注入", async () => {
    const { router, executeScript } = await setup();

    const resp = await router.dispatch(req({}));

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBe("TEXT");
    expect(executeScript).toHaveBeenCalledTimes(1);
    const { files, funcs } = splitCalls(executeScript);
    expect(files).toHaveLength(0);
    expect(funcs).toHaveLength(1);
    expect(funcs[0].target).toEqual({ tabId: 1 });
  });

  it("有 selector 时仍先注入 dom-resolve 再执行 func", async () => {
    const { router, executeScript } = await setup();

    const resp = await router.dispatch(req({ selector: ".x" }));

    expect(resp.error).toBeUndefined();
    expect(executeScript).toHaveBeenCalledTimes(2);
    const [first, second] = executeScript.mock.calls.map((c) => (c[0] ?? {}) as Injection);
    // 第 1 次:loader 预加载
    expect(first.files).toEqual(["page-side/dom-resolve.js"]);
    expect(first.world).toBe("MAIN");
    expect(first.func).toBeUndefined();
    // 第 2 次:正文 func
    expect(second.files).toBeUndefined();
    expect(typeof second.func).toBe("function");
    expect(second.args?.[0]).toBe(".x");
  });

  it("index 路径反查出 selector 后仍注入 dom-resolve(不误伤 shadow 穿透)", async () => {
    const { router, executeScript, setSnapshot } = await setup();
    setSnapshot("s1", {
      tabId: 1,
      capturedAt: Date.now(),
      elements: [{ index: 0, selector: ".from-snapshot" }],
    });

    const resp = await router.dispatch(req({ index: 0, snapshotId: "s1" }));

    expect(resp.error).toBeUndefined();
    const { files, funcs } = splitCalls(executeScript);
    expect(files).toHaveLength(1);
    expect(files[0].files).toEqual(["page-side/dom-resolve.js"]);
    expect(files[0].world).toBe("MAIN");
    expect(funcs).toHaveLength(1);
    expect(funcs[0].args?.[0]).toBe(".from-snapshot");
  });

  it("index 路径拿不到 snapshot 时不注入任何模块,也不把异常抛给调用方", async () => {
    const { router, executeScript, VtxErrorCode } = await setup();

    const resp = await router.dispatch(req({ index: 0, snapshotId: "missing" }));

    expect(resp.error?.code).toBe(VtxErrorCode.STALE_SNAPSHOT);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("空字符串 selector 被判为非法参数,不做任何注入", async () => {
    const { router, executeScript, VtxErrorCode } = await setup();

    const resp = await router.dispatch(req({ selector: "" }));

    // 真实行为:resolveTargetOptional 对空串走 resolveTarget 的兜底分支,
    // 抛 INVALID_PARAMS —— 空串不会走到 body 提取路径。
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("反查出空 selector 时走 body 路径,不预加载 dom-resolve", async () => {
    const { router, executeScript, setSnapshot } = await setup();
    setSnapshot("s_empty", {
      tabId: 1,
      capturedAt: Date.now(),
      elements: [{ index: 0, selector: "" }],
    });

    const resp = await router.dispatch(req({ index: 0, snapshotId: "s_empty" }));

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBe("TEXT");
    const { files, funcs } = splitCalls(executeScript);
    expect(files).toHaveLength(0);
    expect(funcs).toHaveLength(1);
    // 空串传给 func ⇒ sel 为假 ⇒ root 取 document.body(不碰 dom-resolve)
    expect(funcs[0].args?.[0]).toBe("");
  });

  it("预加载注入挂死时,无 selector 的 extract 仍能正常返回文本", async () => {
    const { router, executeScript } = await setup("hang");

    const pending = router.dispatch(req({}));
    // 不能 await 永不 settle 的 promise,先挂 catch 再推时间
    const captured = pending.then((r) => r, (e) => e);
    await flushToLoaderCall();
    await vi.advanceTimersByTimeAsync(INJECT_TIMEOUT_MS);
    const resp = await captured;

    expect(resp.error).toBeUndefined();
    expect(resp.error?.code).not.toBe("TIMEOUT");
    expect(resp.result).toBe("TEXT");
    const { files } = splitCalls(executeScript);
    expect(files).toHaveLength(0);
  });

  it("有 selector 时注入挂死仍抛 PAGE_NOT_READY(错误不被吞)", async () => {
    const { router, executeScript, VtxErrorCode } = await setup("hang");

    const pending = router.dispatch(req({ selector: ".x" }));
    const captured = pending.then((r) => r, (e) => e);
    await flushToLoaderCall();
    await vi.advanceTimersByTimeAsync(INJECT_TIMEOUT_MS);
    const resp = await captured;

    expect(resp.error?.code).toBe(VtxErrorCode.PAGE_NOT_READY);
    expect(resp.error?.message).toContain("dom-resolve");
    const { files } = splitCalls(executeScript);
    expect(files).toHaveLength(1);
  });
});
