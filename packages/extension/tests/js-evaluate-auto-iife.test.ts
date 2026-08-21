import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerJsHandlers } from "../src/handlers/js.js";

/**
 * Regression tests for js.evaluate auto-IIFE wrapping (VORTEX_FEEDBACK P1-B1)
 *
 * Top-level `return` is illegal in script context. When the first eval() throws
 * "Illegal return statement", the handler silently retries via `new Function(code)()`
 * which accepts the same body as a function body (return allowed). The retry sets
 * autoIIFE: true so callers / telemetry can see it happened. Real syntax errors
 * inside the body still surface as JS_EXECUTION_ERROR with a hint pointing the
 * caller at manual IIFE wrapping.
 *
 * Two test surfaces:
 *   1. handler-side mapping — stub chrome.scripting.executeScript, verify that
 *      the page-side envelope (result / error / autoIIFE) is mapped correctly
 *      to the dispatcher response and the hint override fires on "Illegal return"
 *      only.
 *   2. page-side func body — extract the func passed to executeScript and invoke
 *      it directly in Node, verifying eval / retry / failure-of-retry branches.
 */

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

describe("js.evaluate auto-IIFE retry (P1-B1)", () => {
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

  describe("handler-side envelope mapping", () => {
    it("returns the bare value when page-side resolves { result }", async () => {
      executeScript.mockResolvedValue([{ result: { result: 42 } }]);
      const resp = await router.dispatch(mkReq("js.evaluate", { code: "21+21" }, 42));
      expect(resp.error).toBeUndefined();
      expect(resp.result).toBe(42);
    });

    it("returns the value transparently when page-side reports autoIIFE recovery", async () => {
      executeScript.mockResolvedValue([
        { result: { result: { ok: true }, autoIIFE: true } },
      ]);
      const resp = await router.dispatch(
        mkReq("js.evaluate", { code: "return {ok:true}" }, 42),
      );
      expect(resp.error).toBeUndefined();
      expect(resp.result).toEqual({ ok: true });
    });

    it("throws JS_EXECUTION_ERROR with auto-IIFE hint when error message includes 'Illegal return'", async () => {
      executeScript.mockResolvedValue([
        { result: { error: "SyntaxError: Illegal return statement" } },
      ]);
      const resp = await router.dispatch(
        mkReq("js.evaluate", { code: "return (" }, 42),
      );
      expect(resp.error?.code).toBe(VtxErrorCode.JS_EXECUTION_ERROR);
      expect(resp.error?.message).toMatch(/Illegal return/);
      expect(resp.error?.hint).toMatch(/auto-IIFE retry/i);
      expect(resp.error?.hint).toMatch(/\(function\(\)\{/);
    });

    it("throws JS_EXECUTION_ERROR WITHOUT the auto-IIFE hint for non-return errors (default hint preserved)", async () => {
      executeScript.mockResolvedValue([
        { result: { error: "ReferenceError: foo is not defined" } },
      ]);
      const resp = await router.dispatch(
        mkReq("js.evaluate", { code: "foo.bar" }, 42),
      );
      expect(resp.error?.code).toBe(VtxErrorCode.JS_EXECUTION_ERROR);
      expect(resp.error?.message).toMatch(/foo is not defined/);
      expect(resp.error?.hint).not.toMatch(/auto-IIFE/i);
    });

    it("applies the same hint mapping to js.evaluateAsync (shared jsExecutionError helper)", async () => {
      executeScript.mockResolvedValue([
        { result: { error: "SyntaxError: Illegal return statement" } },
      ]);
      const resp = await router.dispatch(
        mkReq("js.evaluateAsync", { code: "return await x" }, 42),
      );
      expect(resp.error?.code).toBe(VtxErrorCode.JS_EXECUTION_ERROR);
      expect(resp.error?.hint).toMatch(/auto-IIFE retry/i);
    });
  });

  describe("page-side func body (direct invocation)", () => {
    async function captureFunc(): Promise<{
      func: (c: string, serSrc: string) => unknown;
      serSrc: string;
    }> {
      executeScript.mockResolvedValue([{ result: { result: null } }]);
      await router.dispatch(mkReq("js.evaluate", { code: "null" }, 42));
      const call = executeScript.mock.calls[0][0];
      const fn = call.func as (c: string, serSrc: string) => unknown;
      executeScript.mockClear();
      return { func: fn, serSrc: call.args[1] as string };
    }

    it("vanilla eval path: simple expression returns { result }", async () => {
      const { func, serSrc } = await captureFunc();
      expect(func("1 + 1", serSrc)).toEqual({ result: 2 });
    });

    it("auto-IIFE recovery: top-level `return` triggers retry, returns { result, autoIIFE:true }", async () => {
      const { func, serSrc } = await captureFunc();
      const out = func("return 42", serSrc) as { result?: unknown; autoIIFE?: boolean; error?: string };
      expect(out.error).toBeUndefined();
      expect(out.result).toBe(42);
      expect(out.autoIIFE).toBe(true);
    });

    it("auto-IIFE retry covers multi-statement body with `return` as last statement", async () => {
      const { func, serSrc } = await captureFunc();
      const out = func("const x = {a:1, b:2}; return JSON.stringify(x);", serSrc) as {
        result?: unknown;
        autoIIFE?: boolean;
      };
      expect(out.result).toBe('{"a":1,"b":2}');
      expect(out.autoIIFE).toBe(true);
    });

    it("retry-of-retry failure: real syntax error inside return → { error } (no infinite loop)", async () => {
      const { func, serSrc } = await captureFunc();
      const out = func("return {", serSrc) as { error?: string; result?: unknown };
      expect(out.result).toBeUndefined();
      expect(out.error).toBeDefined();
      expect(out.error).toMatch(/SyntaxError|Unexpected/);
    });

    it("non-'Illegal return' errors are NOT retried — passed through with original message", async () => {
      const { func, serSrc } = await captureFunc();
      const out = func("nonExistentVar123.foo", serSrc) as { error?: string };
      expect(out.error).toMatch(/nonExistentVar123|not defined/);
      expect(out.error).not.toMatch(/Illegal return/);
    });

    it("legitimate script-context code (no `return`) is unchanged — autoIIFE flag absent", async () => {
      const { func, serSrc } = await captureFunc();
      const out = func("({ok:1})", serSrc) as { result?: unknown; autoIIFE?: boolean };
      expect(out.result).toEqual({ ok: 1 });
      expect(out.autoIIFE).toBeUndefined();
    });
  });
});
