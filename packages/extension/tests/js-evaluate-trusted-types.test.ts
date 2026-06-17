import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerJsHandlers } from "../src/handlers/js.js";

/**
 * Regression tests for js.evaluate / js.evaluateAsync Trusted Types fallback
 * (youtube dogfood 2026-06-01).
 *
 * 现象:Google 系站点启用 `require-trusted-types-for 'script'` 时,vortex_evaluate
 * 注入 func 内的 `eval(string)` / `new Function(string)` 被 CSP 拒,抛
 * "...violates this document's Trusted Type assignment requirements"。Playwright
 * 走 CDP Runtime.evaluate 不受限,vortex 走 content-script 注入受限。
 *
 * 修复:裸字符串求值被 TT 拦截时,用命名 policy(`vortex-eval`,createScript:s=>s)
 * 把代码包成 TrustedScript 再求值绕过。策略创建受页面 trusted-types 指令约束,
 * 失败则优雅回退抛原错(不比现状更糟)。
 *
 * 测试面:捕获注入 page-side func,在 Node 里模拟 TT 强制——stub globalThis.eval
 * 对裸字符串抛 TT 错、对 TrustedScript 包装对象执行内部代码;stub
 * globalThis.trustedTypes 提供命名 policy。
 */

const TT_MSG =
  "Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements";
const TRUSTED = Symbol("vortex-test-trusted");

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

describe("js.evaluate Trusted Types fallback (youtube dogfood 2026-06-01)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  const realEval = globalThis.eval;
  const realFunction = globalThis.Function;

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

  afterEach(() => {
    globalThis.eval = realEval;
    globalThis.Function = realFunction;
    delete (globalThis as Record<string, unknown>).trustedTypes;
    delete (globalThis as Record<string, unknown>).__vortexTTPolicy;
  });

  async function captureFunc(tool: string): Promise<(c: string) => unknown> {
    executeScript.mockResolvedValue([{ result: { result: null } }]);
    await router.dispatch(mkReq(tool, { code: "null" }));
    const fn = executeScript.mock.calls[0][0].func as (c: string) => unknown;
    executeScript.mockClear();
    return fn;
  }

  /** 模拟页面 TT 强制:裸字符串 eval 抛 TT 错,TrustedScript 包装对象正常执行。 */
  function enforceTrustedTypes(opts: { policyCreatable?: boolean; msg?: string } = {}) {
    const policyCreatable = opts.policyCreatable ?? true;
    const ttMsg = opts.msg ?? TT_MSG;
    (globalThis as Record<string, unknown>).trustedTypes = {
      createPolicy: (_name: string, rules: { createScript: (s: string) => string }) => {
        if (!policyCreatable) {
          throw new TypeError(
            "Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': Policy \"vortex-eval\" disallowed.",
          );
        }
        return {
          createScript: (s: string) => {
            const boxed = Object(rules.createScript(s)) as object;
            (boxed as Record<symbol, unknown>)[TRUSTED] = true;
            return boxed as unknown as string;
          },
        };
      },
    };
    globalThis.eval = ((arg: unknown) => {
      if (arg && typeof arg === "object" && (arg as Record<symbol, unknown>)[TRUSTED]) {
        return realEval(String(arg));
      }
      if (typeof arg === "string") throw new EvalError(ttMsg);
      return realEval(arg as string);
    }) as typeof eval;
    // new Function 在 TT 页**恒抛**——与 eval 不同,Function 构造器对所有参数 ToString 后
    // 重新校验,TrustedScript **不被豁免**(live 实证 2026-06-17 youtube:`eval(ts)`→7 成功,
    // `new Function(ts)`→TT 错)。旧 mock 错误地放行 `new Function(TrustedScript)`,致坏掉的
    // async 路径在单测里假绿、却在 YouTube 实站崩。
    globalThis.Function = function (_body: unknown) {
      throw new EvalError(ttMsg);
    } as unknown as FunctionConstructor;
  }

  describe("js.evaluate", () => {
    it("on a Trusted Types page, eval(string) is retried through the named policy", async () => {
      const func = await captureFunc("js.evaluate");
      enforceTrustedTypes();
      const out = func("1 + 1") as { result?: unknown; error?: string };
      expect(out.error).toBeUndefined();
      expect(out.result).toBe(2);
    });

    it("when policy creation is blocked by CSP, the original TT error surfaces (graceful)", async () => {
      const func = await captureFunc("js.evaluate");
      enforceTrustedTypes({ policyCreatable: false });
      const out = func("1 + 1") as { result?: unknown; error?: string };
      expect(out.result).toBeUndefined();
      expect(out.error).toMatch(/Trusted Type/);
    });

    it("non-TT pages are unaffected — plain eval runs, no policy created", async () => {
      const func = await captureFunc("js.evaluate");
      // 不安装 trustedTypes:真实 eval 直接执行。
      const out = func("2 + 3") as { result?: unknown; error?: string };
      expect(out.result).toBe(5);
      expect((globalThis as Record<string, unknown>).__vortexTTPolicy).toBeUndefined();
    });

    it("matches the alternate real Chrome eval-sink wording (requires 'TrustedScript' assignment)", async () => {
      const func = await captureFunc("js.evaluate");
      enforceTrustedTypes({
        msg: "Refused to evaluate a string as JavaScript because this document requires 'TrustedScript' assignment.",
      });
      const out = func("8 + 9") as { result?: unknown; error?: string };
      expect(out.error).toBeUndefined();
      expect(out.result).toBe(17);
    });

    it("a user error merely mentioning 'trusted type' (not a CSP rejection) does NOT trigger the policy path or double-execute", () => {
      // 非强制页:真实 eval 直接跑用户代码。trustedTypes 可用且 createPolicy 成功。
      (globalThis as Record<string, unknown>).trustedTypes = {
        createPolicy: (_n: string, r: { createScript: (s: string) => string }) => ({
          createScript: r.createScript,
        }),
      };
      const g = globalThis as Record<string, unknown>;
      g.__ttSideEffect = 0;
      // 真实 eval 运行 → 计数 +1 → 抛含 "trusted type" 但无 "assignment" 的错误。
      // 旧正则会匹配 → 建 policy → 二次 eval(计数变 2);新正则不匹配 → 只跑一次。
      return router
        .dispatch(mkReq("js.evaluate", { code: "null" }))
        .then(() => {
          const func = executeScript.mock.calls[0][0].func as (c: string) => unknown;
          const out = func(
            "globalThis.__ttSideEffect++; throw new Error('a trusted type mismatch happened');",
          ) as { error?: string };
          expect(out.error).toMatch(/trusted type mismatch/);
          expect(g.__ttSideEffect).toBe(1); // 只执行一次,无 policy 重试
          expect(g.__vortexTTPolicy).toBeUndefined();
          delete g.__ttSideEffect;
        });
    });
  });

  describe("js.evaluateAsync", () => {
    it("on a Trusted Types page, the async wrapper is built through the named policy", async () => {
      const func = await captureFunc("js.evaluateAsync");
      enforceTrustedTypes();
      const out = (await func("return 6 * 7")) as { result?: unknown; error?: string };
      expect(out.error).toBeUndefined();
      expect(out.result).toBe(42);
    });

    // live 复现(youtube 2026-06-17):`vortex_evaluate({async:true})` 多语句 code 在 TT 页 100% 崩。
    // 根因——async page-side 走 `new Function(p.createScript(src))`,但 `new Function` 不接受
    // TrustedScript(只有 eval 接受)。修复:async 路径改用 `eval` + 表达式 IIFE 形式。
    it("on a Trusted Types page, async multi-statement code runs (eval+policy, not new Function)", async () => {
      const func = await captureFunc("js.evaluateAsync");
      enforceTrustedTypes();
      const out = (await func("const a = 3; const b = 4; return a * b;")) as {
        result?: unknown;
        error?: string;
      };
      expect(out.error).toBeUndefined();
      expect(out.result).toBe(12);
    });

    // 表达式形式选择须在 TT 页也生效:纯表达式必须走 exprSrc 形式才能返回值(stmtSrc 形式
    // `{ ${c} }` 无 return → undefined)。旧实现用 `new Function(exprSrc)` 做语法探测,TT 页
    // 上恒抛 TT 错(非 SyntaxError)→ 无法区分 → 退化为 stmtSrc → 纯表达式丢值。
    it("on a Trusted Types page, async pure expression returns its value", async () => {
      const func = await captureFunc("js.evaluateAsync");
      enforceTrustedTypes();
      const out = (await func("6 * 7")) as { result?: unknown; error?: string };
      expect(out.error).toBeUndefined();
      expect(out.result).toBe(42);
    });

    it("on a Trusted Types page, async await-expression resolves", async () => {
      const func = await captureFunc("js.evaluateAsync");
      enforceTrustedTypes();
      const out = (await func("await Promise.resolve(123)")) as {
        result?: unknown;
        error?: string;
      };
      expect(out.error).toBeUndefined();
      expect(out.result).toBe(123);
    });

    // policy 不可创建(站点 trusted-types 指令带 allowlist 不含 vortex-eval)→ page-side 无法
    // 自救,优雅返回原始 TT 错(由 handler 决定是否回退 CDP,见 csp-cdp-fallback 测试)。
    it("when policy creation is blocked, async surfaces the original TT error (graceful)", async () => {
      const func = await captureFunc("js.evaluateAsync");
      enforceTrustedTypes({ policyCreatable: false });
      const out = (await func("return 6 * 7")) as { result?: unknown; error?: string };
      expect(out.result).toBeUndefined();
      expect(out.error).toMatch(/Trusted Type/);
    });
  });
});
