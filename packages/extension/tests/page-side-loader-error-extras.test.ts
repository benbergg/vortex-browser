/**
 * Author: qingwa
 * Description: page-side 注入超时的 agent 可见 hint 契约。
 *
 * 背景（2026-08-13 transcript 挖掘 / 7 天日志分析）：
 * - 注入超时抛的 PAGE_NOT_READY，其 hint 必须与 shared 的 PAGE_NOT_READY_INJECT_HINT
 *   **恒等**（单一真源）。此前 loader 内联写死了一段 hint 文案，与 shared 的 hint 表
 *   不是同一真源，且未登记进 OVERRIDE_HINTS ⇒ 绕过了 I19/I20 的 hint 质量契约。
 * - agent 只能看到 `Error [CODE]: message` + `Hint:`（MCP 渲染层不输出 context，
 *   见 packages/mcp/src/lib/dispatch-error.ts:13-32 与 packages/mcp/src/server.ts:81-87），
 *   所以 hint 不得把人引向 context.extras 这类收不到的字段，也不得承诺「重试一定成功」。
 *
 * 本文件与 packages/extension/tests/page-side-loader-inject-timeout-code.test.ts 同源
 * （错误分类 / message 形态），但断言的是 hint 合同，二者互补。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { type VtxError, VtxErrorCode } from "@vortex-browser/shared";

let executeScriptMock: Mock;

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
  return { ...loader, shared };
}

/** 捕获永不 settle 的注入超时错误：不能 await 永不 settle 的 promise。 */
async function captureInjectTimeout() {
  const { loadPageSideModule, shared } = await importLoaderWithHangingInject();

  let settled = false;
  const pending = loadPageSideModule(1, undefined, "dom-resolve");
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

describe("page-side 注入超时的 hint 合同", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("hint 不引向 agent 收不到的 context.extras", async () => {
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

  it("message 形态不变：保留模块名与 SW/navigation 诊断信息", async () => {
    const { err } = await captureInjectTimeout();

    expect(err.message).toContain("dom-resolve");
    expect(err.message).toContain("SW/navigation");
  });
});
