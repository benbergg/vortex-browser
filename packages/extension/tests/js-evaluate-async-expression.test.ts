import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { buildAsyncSrc, registerJsHandlers } from "../src/handlers/js.js";

/**
 * VORTEX_FEEDBACK v3.3 B3-4 (V2 修正): vortex_evaluate { async: true } 表达式形式支持
 *
 * 根因(同 V1):js.ts:213 写死 `return (async () => { ${c} })()` 函数体形式,
 * 表达式 c 无 return → async 隐式返 undefined。
 *
 * V2 修正核心(防 V1 致命错误):page-side func **不能**调模块级 buildAsyncSrc
 * (chrome.scripting.executeScript 序列化 toString 注入页面,丢模块作用域)。
 * → func 内联同一 form-selection 逻辑;模块级 buildAsyncSrc 仅供单测。
 *
 * 关键守卫(防假绿):
 *   - "func.toString() 不含 buildAsyncSrc" (V2 加)
 *   - 真注入 func 后真跑多个 case (V1 已有,扩展到 5 case)
 */

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId = 42,
): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

describe("buildAsyncSrc — 表达式/语句形式选择 (B3-4)", () => {
  const cases: Array<[label: string, c: string, expected: unknown]> = [
    ["纯异步表达式", "Promise.resolve(42)", 42],
    ["函数体含 return (旧契约)", "return { ok: true }", { ok: true }],
    ["IIFE 表达式", "(async () => 99)()", 99],
    ["表达式含 await", "await Promise.resolve(7)", 7],
    ["纯同步表达式", "1 + 1", 2],
  ];

  for (const [label, c, expected] of cases) {
    it(`${label} → new Function(buildAsyncSrc(c))() 真跑返 expected`, async () => {
      const src = buildAsyncSrc(c);
      const fn = new Function(src) as () => Promise<unknown>;
      expect(await fn()).toEqual(expected);
    });
  }

  it("非法语法 c → buildAsyncSrc 不抛(报错留给执行期)", () => {
    expect(() => buildAsyncSrc("return {")).not.toThrow();
  });
});

describe("EVALUATE_ASYNC page-side func — 自包含 + 真跑 (B3-4)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
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
    registerJsHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function captureAsyncFunc(): Promise<(c: string) => Promise<{ result?: unknown; error?: string }>> {
    executeScript.mockResolvedValue([{ result: { result: null } }]);
    await router.dispatch(
      mkReq("js.evaluateAsync", { code: "null" }, 42),
    );
    const fn = executeScript.mock.calls[0][0].func as (c: string) => Promise<{ result?: unknown; error?: string }>;
    executeScript.mockClear();
    return fn;
  }

  // V2 关键守卫:防 V1 假绿 —— func 源码不能引用 buildAsyncSrc
  it("func 序列化安全:源码不引用模块函数 buildAsyncSrc", async () => {
    const fn = await captureAsyncFunc();
    // 剥离行/块注释后再断言:func 已内联,buildAsyncSrc 仅出现在解释性注释,裸正则误匹配 → 假阳。
    const src = fn.toString().replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/buildAsyncSrc/);
  });

  it("纯表达式 'Promise.resolve(42)' → { result: 42 }", async () => {
    const fn = await captureAsyncFunc();
    const out = await fn("Promise.resolve(42)");
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(42);
  });

  it("函数体 'return { ok: true }' → { ok: true } (旧契约不破)", async () => {
    const fn = await captureAsyncFunc();
    const out = await fn("return { ok: true }");
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ ok: true });
  });

  it("IIFE '(async () => 99)()' → 99", async () => {
    const fn = await captureAsyncFunc();
    const out = await fn("(async () => 99)()");
    expect(out.result).toBe(99);
  });

  it("表达式含 await 'await Promise.resolve(7)' → 7", async () => {
    const fn = await captureAsyncFunc();
    const out = await fn("await Promise.resolve(7)");
    expect(out.result).toBe(7);
  });

  it("真实语法错误 'return {' → { error } 透传", async () => {
    const fn = await captureAsyncFunc();
    const out = await fn("return {");
    expect(out.result).toBeUndefined();
    expect(out.error).toMatch(/SyntaxError|Unexpected/);
  });
});
