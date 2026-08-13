/**
 * Author: qingwa
 * Description: page-side 模块注入超时必须分类为 PAGE_NOT_READY，而不是冒到 router 兜底变 JS_EXECUTION_ERROR。
 *
 * 背景(2026-08-13 transcript 挖掘,3/60 次,全在 extract):注入超时抛的是裸 Error,
 * 于是被归成 JS_EXECUTION_ERROR,hint 说"Injected JavaScript threw an error...
 * adjust the selector or action arguments"——调用方根本没注入 JS,真因是目标 tab
 * 处于坏 SW/navigation 状态。与 dd3a2c5 修的 attach 分类完全同构。
 *
 * page-side-loader.ts:32-33 的注释本就写着"非泛化 TIMEOUT,失败原因清晰可辨",
 * 但因为抛的是裸 Error,这个意图从未落地。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { type VtxError, VtxErrorCode } from "@vortex-browser/shared";

let executeScriptMock: Mock;

// vi.resetModules() 会让 shared 重新求值，顶层 import 的 VtxError 与 loader 实际
// 抛出的不是同一个类，instanceof 必然为假。取同一模块图里的那份才有意义。
async function importLoaderWithHangingInject() {
  vi.resetModules();
  // 永不 settle:复刻坏 SW/navigation 态下 executeScript 挂死的现场
  executeScriptMock = vi.fn(() => new Promise(() => {}));

  (globalThis as any).chrome = {
    scripting: { executeScript: executeScriptMock },
    tabs: { onRemoved: { addListener: vi.fn() } },
    webNavigation: { onCommitted: { addListener: vi.fn() } },
  };

  const loader = await import("../src/adapter/page-side-loader.js");
  const shared = await import("@vortex-browser/shared");
  return { ...loader, SharedVtxError: shared.VtxError };
}

describe("page-side 注入超时的错误分类", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("抛 VtxError(PAGE_NOT_READY) 而非裸 Error", async () => {
    const { loadPageSideModule, SharedVtxError } = await importLoaderWithHangingInject();

    const pending = loadPageSideModule(1, undefined, "dom-resolve");
    const captured = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3000);
    const err = await captured;

    expect(err).toBeInstanceOf(SharedVtxError);
    expect((err as VtxError).code).toBe(VtxErrorCode.PAGE_NOT_READY);
    // 注入确实被尝试过，否则这个测试测的是空气
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
  });

  it("hint 不再把人引向 selector / 自己注入的 JS", async () => {
    const { loadPageSideModule } = await importLoaderWithHangingInject();

    const pending = loadPageSideModule(1, undefined, "dom-resolve");
    const captured = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3000);
    const err = (await captured) as VtxError;

    const hint = err.extra?.hint ?? "";
    expect(hint).not.toMatch(/selector/i);
    expect(hint).not.toMatch(/Injected JavaScript/i);
    // 可重试是这个失败的关键属性：message 里写着 retryable，码的语义必须一致
    expect(err.extra?.recoverable).toBe(true);
  });

  it("message 保留 SW/navigation 诊断信息与模块名", async () => {
    const { loadPageSideModule } = await importLoaderWithHangingInject();

    const pending = loadPageSideModule(1, undefined, "dom-resolve");
    const captured = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3000);
    const err = (await captured) as VtxError;

    expect(err.message).toContain("dom-resolve");
    expect(err.message).toContain("SW/navigation");
  });
});
