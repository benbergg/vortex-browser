import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";

/**
 * VORTEX_FEEDBACK v3.4 BUG-004: vortex_wait_for mode:custom IIFE 永远立即 ready
 * 根因:page.ts:358 `const v = eval(expr)`,IIFE 形式 `() => false` 被求值为箭头函数对象
 * (truthy),`if (v)` 永远 true → 立即 ready。
 *
 * 修复:handler 检测 IIFE 形式,自动 `eval('(' + expr + ')()')` 调用。
 *
 * 关键守卫:
 *   - 裸值 (false/0/null) 行为不变
 *   - IIFE 形式 (() => false / () => 0 / () => ({count: 0})) 行为正确
 *   - async IIFE 调真异步
 *   - 自调用 IIFE 字符串 (function(){return false}()) 行为不变
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

describe("vortex_wait_for mode:custom — IIFE 智能检测 (BUG-004)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    // stub requestAnimationFrame for page-side polling (node env 没 rAF)
    (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    router = new ActionRouter();
    executeScript = vi.fn();
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
    registerPageHandlers(router);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as any).requestAnimationFrame;
  });

  // 让 wait_for 走真注入 page-side func 路径
  // 模拟 executeScript 返 ok=false (timeout / never truthy)
  async function captureFunc() {
    executeScript.mockResolvedValue([
      { result: { ok: false, waitedMs: 50, error: "Expression never resolved truthy" } },
    ]);
    try {
      await router.dispatch(mkReq("page.waitForExpression", { expression: "false", timeout: 100 }, 42));
    } catch {}
    const fn = executeScript.mock.calls[0][0].func as (e: string, t: number, i: number) => Promise<{ ok: boolean; value?: unknown; waitedMs: number; error?: string }>;
    executeScript.mockClear();
    return fn;
  }

  it("裸值 'false' → 返 false (falsy) → 不 ready", async () => {
    const fn = await captureFunc();
    const r = await fn("false", 50, 10);
    expect(r.ok).toBe(false);
  });

  it("裸值 '0' → 返 0 (falsy) → 不 ready", async () => {
    const fn = await captureFunc();
    const r = await fn("0", 50, 10);
    expect(r.ok).toBe(false);
  });

  it("裸值 'null' → 返 null (falsy) → 不 ready", async () => {
    const fn = await captureFunc();
    const r = await fn("null", 50, 10);
    expect(r.ok).toBe(false);
  });

  it("IIFE '() => false' → 修复后返 false (falsy) → 不 ready (原 BUG: 永远 ready)", async () => {
    const fn = await captureFunc();
    const r = await fn("() => false", 50, 10);
    expect(r.ok).toBe(false);
  });

  it("IIFE '() => 0' → 修复后返 0 (falsy) → 不 ready", async () => {
    const fn = await captureFunc();
    const r = await fn("() => 0", 50, 10);
    expect(r.ok).toBe(false);
  });

  it("IIFE '() => ({count: 0})' → 修复后返对象,value 是 {count:0} 非箭头函数", async () => {
    const fn = await captureFunc();
    const r = await fn("() => ({count: 0})", 50, 10);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ count: 0 });
  });

  it("IIFE '() => 1' (truthy) → 立即 ready, value=1", async () => {
    const fn = await captureFunc();
    const r = await fn("() => 1", 50, 10);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(1);
  });

  it("自调用 IIFE '(function(){ return false })()' → 返 false (falsy)", async () => {
    const fn = await captureFunc();
    const r = await fn("(function(){ return false })()", 50, 10);
    expect(r.ok).toBe(false);
  });

  it("自调用 IIFE '(function(){ return 99 })()' → 返 99 (truthy)", async () => {
    const fn = await captureFunc();
    const r = await fn("(function(){ return 99 })()", 50, 10);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(99);
  });

  it("IIFE 抛错 → catch,err 透传,继续 polling", async () => {
    const fn = await captureFunc();
    const r = await fn("() => { throw new Error('test') }", 50, 10);
    // 抛错时 v 未定义,走 catch,lastError 记录后继续 polling,最终 ok=false
    expect(r.ok).toBe(false);
    expect(r.error).toContain("test");
  });

  it("IIFE '() => 1+2' (算术) → 立即 ready, value=3", async () => {
    const fn = await captureFunc();
    const r = await fn("() => 1+2", 50, 10);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(3);
  });
});
