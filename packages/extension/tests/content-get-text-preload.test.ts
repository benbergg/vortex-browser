/**
 * @vitest-environment jsdom
 */
/**
 * Author: mcode (MiniMax-M3.1-Flash)
 * Description: GET_TEXT 的 page-side 预加载必须按需——没有 selector 时不注入 dom-resolve。
 *
 * 证据等级（重要，勿越级断言）：历史上观察到 5 次**无 selector** 的 extract 请求返回
 * PAGE_NOT_READY（同期同 tab 也有无 selector 的 extract 成功过）。这只能说明
 * "无 selector 路径与该错误相关"，**不**证明底层注入故障的根因——那几次调用在预加载
 * 阶段就中止了，同态的 func 注入当时并未执行；也**不**证明真机恢复（真机 DAST 未开展）。
 * 本文件只验证一件事：**移除这处无用预加载**的行为契约（无 selector 时不再触发
 * files 注入；func 本身不依赖 dom-resolve）。
 *
 * 其它：真实 dispatch(ActionRouter + registerContentHandlers)，只 mock chrome.*，
 * 不用源码正则匹配（改注释就能骗过正则测试）。
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

// jsdom 未实现 innerText（vortex 的注入 func 读 innerText，不是 textContent）。
// 这里按 textContent 近似：测试只关心"能否取到文本 / 能否穿透 shadow"，不做 CSS 可见性模拟。
if (!("innerText" in window.HTMLElement.prototype)) {
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent;
    },
  });
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
    // loader 预加载(files):默认 settle;hang 复刻坏 SW/navigation 态下永不 settle
    if (Array.isArray(injection?.files)) {
      if (files === "hang") return new Promise(() => {});
      return Promise.resolve([{ result: undefined }]);
    }
    // 正文注入(func):只有真的带 func 才给正文响应
    if (typeof injection?.func === "function") {
      return Promise.resolve([{ result: { result: "TEXT" } }]);
    }
    // 既没有 files 也没有 func:形状不认识 ⇒ 直接炸,不静默通过
    throw new Error("Unexpected injection shape");
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
      // ensureFrameAttached 用它判定 frame 是否还挂着
      getAllFrames: vi.fn(async () => [{ frameId: 0 }, { frameId: 5 }, { frameId: 9 }]),
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
 * 让 handler 推进到真正调用 loader 为止。
 * loader 的 3s 定时器是在 `await loadPageSideModule(...)` 求值时于 loader 内部
 * 同步创建的（injectWithTimeout 里 setTimeout 同步注册），但这次调用发生在 handler
 * 入口 `getActiveTabId` 的异步续体之后 ⇒ 先冲刷该续体，定时器才能在推进 3000ms 前注册。
 */
async function flushToLoaderCall(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** 从 mock 里取出真实注入的正文 func（不自己抄一份） */
function captureBodyFunc(executeScript: Mock): (...args: unknown[]) => Promise<unknown> {
  const funcs = splitCalls(executeScript).funcs;
  expect(funcs).toHaveLength(1);
  return funcs[0].func as (...args: unknown[]) => Promise<unknown>;
}

/**
 * 造一个**故意没有** window.__vortexDomResolve 的 DOM：
 * 正文节点 + light DOM 的 input + 两层嵌套 open shadow（外层含 input，内层含文字）。
 */
function buildDomWithoutDomResolve(): void {
  document.body.innerHTML = "";

  const bodyText = document.createElement("div");
  bodyText.id = "body-text";
  bodyText.textContent = "Visible body text";
  document.body.appendChild(bodyText);

  const field = document.createElement("input");
  field.id = "field";
  field.type = "text";
  field.setAttribute("value", "light-value");
  field.setAttribute("data-role", "primary");
  document.body.appendChild(field);

  const outerHost = document.createElement("div");
  outerHost.id = "outer-host";
  document.body.appendChild(outerHost);
  const outerRoot = outerHost.attachShadow({ mode: "open" });

  const shadowField = document.createElement("input");
  shadowField.id = "shadow-field";
  shadowField.type = "text";
  shadowField.setAttribute("value", "shadow-value");
  outerRoot.appendChild(shadowField);

  const outerText = document.createElement("p");
  outerText.textContent = "Outer shadow text";
  outerRoot.appendChild(outerText);

  const innerHost = document.createElement("div");
  innerHost.id = "inner-host";
  outerRoot.appendChild(innerHost);
  const innerRoot = innerHost.attachShadow({ mode: "open" });
  const deep = document.createElement("span");
  deep.id = "deep";
  deep.textContent = "Deep shadow text";
  innerRoot.appendChild(deep);
}

const DEFAULT_OPTS = {
  wantValue: false,
  wantAttrs: false,
  maxDepth: 20,
  scroll: false,
  includeAlt: true,
};

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

  it("index 路径绑定 snapshot 的 tabId(优先于请求里的 tabId)", async () => {
    const { router, executeScript, setSnapshot } = await setup();
    // snapshot 的 tabId=7 ≠ 请求里的 tabId=1 ⇒ 以 boundTabId 为准(content.ts:31)
    setSnapshot("s_tab", {
      tabId: 7,
      capturedAt: Date.now(),
      elements: [{ index: 0, selector: ".bound" }],
    });

    const resp = await router.dispatch(req({ index: 0, snapshotId: "s_tab" }));

    expect(resp.error).toBeUndefined();
    const { files, funcs } = splitCalls(executeScript);
    expect(files[0].target).toEqual({ tabId: 7 });
    expect(funcs[0].target).toEqual({ tabId: 7 });
  });

  it("index 路径取元素级 frameId(优先于 snapshot 级 frameId;0 是有效值)", async () => {
    const { router, executeScript, setSnapshot } = await setup();
    // 元素 frameId=0 优先于 snapshot frameId=5；`??` 不是 `||`,0 是有效 frame
    setSnapshot("s_frame0", {
      tabId: 1,
      frameId: 5,
      capturedAt: Date.now(),
      elements: [{ index: 0, selector: ".bound", frameId: 0 }],
    });

    const resp = await router.dispatch(req({ index: 0, snapshotId: "s_frame0" }));

    expect(resp.error).toBeUndefined();
    const { files, funcs } = splitCalls(executeScript);
    expect(files[0].target).toEqual({ tabId: 1, frameIds: [0] });
    expect(funcs[0].target).toEqual({ tabId: 1, frameIds: [0] });
  });

  it("index 路径取元素级 frameId 的非零值", async () => {
    const { router, executeScript, setSnapshot } = await setup();
    setSnapshot("s_frame9", {
      tabId: 1,
      frameId: 5,
      capturedAt: Date.now(),
      elements: [{ index: 0, selector: ".bound", frameId: 9 }],
    });

    const resp = await router.dispatch(req({ index: 0, snapshotId: "s_frame9" }));

    expect(resp.error).toBeUndefined();
    const { files, funcs } = splitCalls(executeScript);
    expect(files[0].target).toEqual({ tabId: 1, frameIds: [9] });
    expect(funcs[0].target).toEqual({ tabId: 1, frameIds: [9] });
  });

  it("index 路径拿不到 snapshot 时不注入任何模块,也不把异常抛给调用方", async () => {
    const { router, executeScript, VtxErrorCode } = await setup();

    const resp = await router.dispatch(req({ index: 0, snapshotId: "missing" }));

    expect(resp.error?.code).toBe(VtxErrorCode.STALE_SNAPSHOT);
    // 失败信封必须带 hint 与 recoverable,agent 才知道下一步该干什么
    expect(resp.error?.hint).toBeTruthy();
    expect(resp.error?.recoverable).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("空字符串 selector 被判为非法参数,不做任何注入", async () => {
    const { router, executeScript, VtxErrorCode } = await setup();

    const resp = await router.dispatch(req({ selector: "" }));

    // 真实行为:resolveTargetOptional 对空串走 resolveTarget 的兜底分支,
    // 抛 INVALID_PARAMS —— 空串不会走到 body 提取路径。
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(resp.error?.hint).toBeTruthy();
    expect(resp.error?.recoverable).toBe(false);
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
    // 意图提示:内层预算(20s)超时会给 TIMEOUT 信封。前一行已断言整个 error 为 undefined,
    // 这行不构成独立的反平移保障(真机是否退化成 TIMEOUT 需 DAST 验证)。
    expect(resp.error?.code).not.toBe("TIMEOUT");
    expect(resp.result).toBe("TEXT");
    const { files } = splitCalls(executeScript);
    expect(files).toHaveLength(0);
  });

  it("有 selector 时注入挂死仍抛 PAGE_NOT_READY(错误不被吞),且正文注入根本没发生", async () => {
    const { router, executeScript, VtxErrorCode } = await setup("hang");

    const pending = router.dispatch(req({ selector: ".x" }));
    const captured = pending.then((r) => r, (e) => e);
    await flushToLoaderCall();
    await vi.advanceTimersByTimeAsync(INJECT_TIMEOUT_MS);
    const resp = await captured;

    expect(resp.error?.code).toBe(VtxErrorCode.PAGE_NOT_READY);
    expect(resp.error?.message).toContain("dom-resolve");
    expect(resp.error?.hint).toBeTruthy();
    expect(resp.error?.recoverable).toBe(true);
    const { files, funcs } = splitCalls(executeScript);
    expect(files).toHaveLength(1);
    // 预加载失败 ⇒ handler 直接中止,正文 func 一次都没注入
    expect(funcs).toHaveLength(0);
  });
});

describe("真实注入 func 的 DOM 级行为(不依赖 dom-resolve)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  it("没有 __vortexDomResolve 的 DOM 里,inline func 仍能取到正文与嵌套 open shadow 文本", async () => {
    const { router, executeScript } = await setup();
    // 触发一次注入,把**真实**的正文 func 捕获下来（不自己抄一份）
    await router.dispatch(req({}));
    const bodyFunc = captureBodyFunc(executeScript);

    // 前提:DOM 里没有 dom-resolve 的 namespace
    expect((window as any).__vortexDomResolve).toBeUndefined();
    buildDomWithoutDomResolve();

    const res = (await bodyFunc(null, DEFAULT_OPTS)) as { result?: string; error?: string };

    // func 内部把异常吞成 {error},所以这里断言 error 不存在 + 文本齐全
    expect(res.error).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("__vortexDomResolve");
    expect(res.result).toContain("Visible body text");
    // open shadow 文本由 collectShadowText 自遍历 el.shadowRoot 拿到
    expect(res.result).toContain("Outer shadow text");
    // 嵌套 shadow:外层 shadow 的子节点 innerText 拿不到内层,靠继续下钻拿到
    expect(res.result).toContain("Deep shadow text");
  });

  it("include:[\"value\",\"attrs\"] 时控件信息可读(light DOM 与 shadow 内的 input 都读得到)", async () => {
    const { router, executeScript } = await setup();
    await router.dispatch(req({}));
    const bodyFunc = captureBodyFunc(executeScript);

    expect((window as any).__vortexDomResolve).toBeUndefined();
    buildDomWithoutDomResolve();

    const res = (await bodyFunc(null, {
      ...DEFAULT_OPTS,
      wantValue: true,
      wantAttrs: true,
    })) as {
      result?: {
        text?: string;
        controls?: Array<{ id?: string; value?: unknown; attrs?: Record<string, string> }>;
      };
      error?: string;
    };

    expect(res.error).toBeUndefined();
    const controls = res.result?.controls ?? [];
    const light = controls.find((c) => c.id === "field");
    expect(light?.value).toBe("light-value");
    expect(light?.attrs?.["data-role"]).toBe("primary");
    // walkControls 自己下钻 open shadowRoot ⇒ shadow 内的 input 也在
    const shadow = controls.find((c) => c.id === "shadow-field");
    expect(shadow?.value).toBe("shadow-value");
    expect(res.result?.text).toContain("Visible body text");
  });
});
