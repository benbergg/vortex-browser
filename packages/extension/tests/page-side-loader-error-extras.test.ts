/**
 * Author: qingwa
 * Description: page-side 注入超时的 agent 可见 hint 契约。
 *
 * 背景（2026-08-13 transcript 挖掘 / 7 天日志分析）：
 * - 注入超时抛的 PAGE_NOT_READY，其 hint 必须与 shared 的 PAGE_NOT_READY_INJECT_HINT
 *   **恒等**（单一真源）。此前 loader 内联写死了一段 hint 文案，与 shared 的 hint 表
 *   不是同一真源，且未登记进 OVERRIDE_HINTS ⇒ 绕过了 I19/I20 的 hint 质量契约。
 * - **经当前 MCP 错误文本渲染的调用者**只拿到 `Error [CODE]: message` + `Hint:`
 *   （MCP 渲染层不输出 context，见 packages/mcp/src/lib/dispatch-error.ts:13-32 与
 *   packages/mcp/src/server.ts:81-87），所以 hint 不得把人引向 context.extras 这类
 *   读不到的字段，也不得承诺「重试一定成功」。
 *   范围限定：CLI（packages/cli/src/client.ts:85-93）会渲染 context JSON，内部/结构化
 *   消费者也读得到 ⇒ 这里约束的是 MCP 错误文本这一路，不是禁掉 payload 本身。
 *
 * 本文件与 packages/extension/tests/page-side-loader-inject-timeout-code.test.ts 同源
 * （错误分类 / message 关键片段），但断言的是 hint 合同，二者互补。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { type VtxError, VtxErrorCode } from "@vortex-browser/shared";

let executeScriptMock: Mock;
/** 最近一次动态 import 的 loader 模块：afterEach 用它清已加载模块缓存。 */
let loaderModule: typeof import("../src/adapter/page-side-loader.js") | undefined;

/** 注入超时阈值，与 loader 的 INJECT_TIMEOUT_MS 对齐（页面端超时 3000ms）。 */
const INJECT_TIMEOUT_MS = 3000;

/**
 * vi.resetModules() 会让 shared 重新求值，顶层 import 的常量与 loader 实际使用的
 * 未必是同一模块实例——故 hint 常量也从动态 import 里取，比较的是同一模块图里的值。
 */
async function importLoaderWithHangingInject() {
  vi.resetModules();
  // 永不 settle：复刻坏 SW/navigation 态下 executeScript 挂死的现场
  executeScriptMock = vi.fn(() => new Promise(() => {}));

  (globalThis as any).chrome = {
    scripting: { executeScript: executeScriptMock },
    tabs: { onRemoved: { addListener: vi.fn() } },
    webNavigation: { onCommitted: { addListener: vi.fn() } },
  };

  const loader = await import("../src/adapter/page-side-loader.js");
  const shared = await import("@vortex-browser/shared");
  loaderModule = loader;
  return { ...loader, shared };
}

/** 捕获永不 settle 的注入超时错误：不能 await 永不 settle 的 promise。 */
async function captureInjectTimeout(opts: { tabId?: number; frameId?: number } = {}) {
  const { loadPageSideModule, shared } = await importLoaderWithHangingInject();

  const tabId = opts.tabId ?? 1;
  const frameId = opts.frameId;

  let settled = false;
  const pending = loadPageSideModule(tabId, frameId, "dom-resolve");
  const captured = pending.catch((e: unknown) => {
    settled = true;
    return e;
  });

  // 超时阈值必须严格对齐 INJECT_TIMEOUT_MS：2999ms 时不得已失败
  await vi.advanceTimersByTimeAsync(INJECT_TIMEOUT_MS - 1);
  expect(settled, "注入超时早于 INJECT_TIMEOUT_MS 触发").toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  const err = (await captured) as VtxError;
  return { err, shared, executeScriptMock };
}

// fake timer 与 chrome mock 的生命周期对本文件所有 describe 生效（两组用例都要）
beforeEach(() => {
  delete (globalThis as any).chrome;
  loaderModule = undefined;
  vi.useFakeTimers();
});

afterEach(async () => {
  // 先数残留定时器（切回真实定时器后就数不到了），再清理状态。
  expect(vi.getTimerCount(), "用例结束后仍有未清理的定时器").toBe(0);
  vi.useRealTimers();
  // 清掉 loader 的已加载模块缓存，避免跨用例污染（_resetPageSideLoader 为导出）
  loaderModule?._resetPageSideLoader();
  loaderModule = undefined;
  delete (globalThis as any).chrome;
});

describe("page-side 注入超时的 hint 合同", () => {
  it("错误码为 PAGE_NOT_READY 且 recoverable", async () => {
    const { err } = await captureInjectTimeout();

    expect(err.code).toBe(VtxErrorCode.PAGE_NOT_READY);
    expect(err.extra?.recoverable).toBe(true);
    // 注入确实被尝试过，否则这个测试测的是空气
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
  });

  it("hint 恒等于 shared 的 PAGE_NOT_READY_INJECT_HINT（单一真源）", async () => {
    const { err, shared } = await captureInjectTimeout();

    expect(shared.PAGE_NOT_READY_INJECT_HINT).toBeTypeOf("string");
    expect(err.extra?.hint).toBe(shared.PAGE_NOT_READY_INJECT_HINT);
  });

  it("hint 不引向调用方读不到的 context.extras", async () => {
    const { err } = await captureInjectTimeout();

    const hint = err.extra?.hint ?? "";
    expect(hint).not.toMatch(/context\.extras/);
    expect(hint).not.toMatch(/context\.[a-z_]/i);
  });

  it("hint 不承诺「重试一定成功」这类无据保证", async () => {
    const { err } = await captureInjectTimeout();

    const hint = err.extra?.hint ?? "";
    expect(hint).not.toMatch(/guarantee|guaranteed|will succeed|is certain to|一定成功|必定成功|保证成功/i);
  });

  it("hint 指出可落地的下一步（vortex_navigate / vortex_observe）", async () => {
    const { err } = await captureInjectTimeout();

    const hint = err.extra?.hint ?? "";
    // 该失败下 observe 路径的同类预加载是软失败（packages/extension/src/handlers/observe.ts:1100），
    // 故 observe 仍可能可用，hint 必须把它指出来而不是让调用方原地重试。
    expect(hint).toContain("vortex_observe");
    expect(hint).toContain("vortex_navigate");
  });

  it("message 保留关键诊断片段（模块名与 SW/navigation）", async () => {
    const { err } = await captureInjectTimeout();

    // 只锁关键诊断片段，不声称整条 message 逐字不变（逐字不变由 git diff 佐证）。
    expect(err.message).toContain("dom-resolve");
    expect(err.message).toContain("SW/navigation");
  });
});

/**
 * Task 3 —— 注入超时的结构化证据。
 *
 * 背景（7 天日志分析）：历史上 5 次 PAGE_NOT_READY 只有 client 侧 transcript 可查，
 * 服务端零原始日志（hub 启动时只写一行 listening）。agent 与运维都看不到
 * `context.extras` 里的诊断信息 ⇒ 底层诱因（为什么 files 注入 >3s 不 settle）
 * 至今无法定性。
 *
 * 本组用例锁的是「证据契约」：错误信封里必须带得上 module/tabId/frameId/timeoutMs，
 * 且**不改变** agent 可见的 message 与 hint 文案（落盘只增不改可见面）。
 */
describe("page-side 注入超时的 context.extras 结构化证据", () => {
  it("context.extras 带齐 module / tabId / frameId / timeoutMs", async () => {
    const { err } = await captureInjectTimeout({ tabId: 42, frameId: 7 });

    const extras = err.extra?.context?.extras;
    expect(extras, "context.extras 缺失，服务端就无从落盘取证").toBeTypeOf("object");
    expect(extras).toMatchObject({
      module: "dom-resolve",
      tabId: 42,
      frameId: 7,
      timeoutMs: INJECT_TIMEOUT_MS,
    });
  });

  it("frameId 未指定时落 null（不是 undefined，避免消费端两套判空）", async () => {
    const { err } = await captureInjectTimeout({ tabId: 9 });

    const extras = err.extra?.context?.extras as Record<string, unknown>;
    expect("frameId" in extras).toBe(true);
    expect(extras.frameId).toBeNull();
    expect(extras.tabId).toBe(9);
  });

  it("extras 只含诊断字段，不夹带页面内容", async () => {
    const { err } = await captureInjectTimeout({ tabId: 42, frameId: 7 });

    const extras = err.extra?.context?.extras as Record<string, unknown>;
    expect(Object.keys(extras).sort()).toEqual(["frameId", "module", "tabId", "timeoutMs"]);
  });

  it("message 与 hint 文案未变（加证据不改 agent 可见面）", async () => {
    const { err, shared } = await captureInjectTimeout({ tabId: 42, frameId: 7 });

    // 逐字锁 message：证据是「额外通道」，不是改写正文
    expect(err.message).toBe(
      'page-side module "dom-resolve" injection timed out after 3000ms ' +
        "(target tab likely in a bad SW/navigation state); cache evicted, retryable",
    );
    expect(err.extra?.hint).toBe(shared.PAGE_NOT_READY_INJECT_HINT);
    expect(err.extra?.recoverable).toBe(true);
  });
});
