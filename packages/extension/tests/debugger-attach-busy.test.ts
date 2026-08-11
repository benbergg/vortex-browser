/**
 * Author: qingwa
 * Description: DebuggerManager 把 attach 失败分类为 CDP_NOT_ATTACHED 并给对症提示。
 *
 * 背景(2026-08-11 使用基线):`Another debugger is already attached to the tab with
 * id: N.` 是 Chrome 自己抛的裸 Error,冒到 router 兜底后被归成 JS_EXECUTION_ERROR,
 * 附带的 hint 是"Injected JavaScript threw an error. Inspect the error message..."
 * —— agent 会去查自己的 JS,而真因是这个标签页开着 DevTools 或被别的扩展占用。
 * 每次都把人引向完全错误的方向。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type VtxError, VtxErrorCode } from "@vortex-browser/shared";

const BUSY = "Another debugger is already attached to the tab with id: 123.";

function mkChrome(attachError?: Error) {
  return {
    debugger: {
      attach: attachError ? vi.fn().mockRejectedValue(attachError) : vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  };
}

async function mgrWith(attachError?: Error) {
  vi.stubGlobal("chrome", mkChrome(attachError));
  const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
  return new DebuggerManager();
}

async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("DebuggerManager attach 失败的分类", () => {
  beforeEach(() => vi.resetModules());

  it("被别的调试器占用 → CDP_NOT_ATTACHED,而不是 JS_EXECUTION_ERROR", async () => {
    const mgr = await mgrWith(new Error(BUSY));
    const err = (await catchErr(() => mgr.attach(123))) as VtxError;

    expect(err.name).toBe("VtxError");
    expect(err.code).toBe(VtxErrorCode.CDP_NOT_ATTACHED);
    expect(err.code).not.toBe(VtxErrorCode.JS_EXECUTION_ERROR);
  });

  it("被占用时的 hint 指向 DevTools/其他扩展，且标记可恢复", async () => {
    const mgr = await mgrWith(new Error(BUSY));
    const err = (await catchErr(() => mgr.attach(123))) as VtxError;

    expect(err.extra?.hint).toMatch(/DevTools/i);
    // 关掉 DevTools 就能重试,不能沿用 CDP_NOT_ATTACHED 默认的 recoverable:false
    expect(err.extra?.recoverable).toBe(true);
  });

  it("被占用时的 hint 不再谈 manifest 权限或 chrome:// —— 那是另一类失败", async () => {
    const mgr = await mgrWith(new Error(BUSY));
    const err = (await catchErr(() => mgr.attach(123))) as VtxError;

    expect(err.extra?.hint).not.toMatch(/manifest/i);
  });

  it("原始信息保留在 message 里，不被 hint 顶掉", async () => {
    const mgr = await mgrWith(new Error(BUSY));
    const err = (await catchErr(() => mgr.attach(123))) as VtxError;

    expect(err.message).toContain("Another debugger is already attached");
  });

  it("其他 attach 失败仍是 CDP_NOT_ATTACHED，但沿用默认 hint", async () => {
    const mgr = await mgrWith(new Error("Cannot access a chrome:// URL"));
    const err = (await catchErr(() => mgr.attach(123))) as VtxError;

    expect(err.code).toBe(VtxErrorCode.CDP_NOT_ATTACHED);
    expect(err.extra?.hint).toMatch(/manifest/i);
    expect(err.extra?.recoverable).toBe(false);
  });

  it("enableDomain 与 attach 走同一分类，不留第二条未分类通道", async () => {
    const mgr = await mgrWith(new Error(BUSY));
    const err = (await catchErr(() => mgr.enableDomain(123, "DOM"))) as VtxError;

    expect(err.name).toBe("VtxError");
    expect(err.code).toBe(VtxErrorCode.CDP_NOT_ATTACHED);
    expect(err.extra?.recoverable).toBe(true);
  });

  it("attach 失败不把 tab 记成已 attach，否则后续调用会静默走空", async () => {
    const mgr = await mgrWith(new Error(BUSY));
    await catchErr(() => mgr.attach(123));
    // 第二次仍应真的去 attach（而不是命中缓存直接返回成功）
    const err = (await catchErr(() => mgr.attach(123))) as VtxError;
    expect(err.code).toBe(VtxErrorCode.CDP_NOT_ATTACHED);
  });
});
