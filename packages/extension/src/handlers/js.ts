import { JsActions, VtxErrorCode, vtxError } from "@bytenew/vortex-shared";
import type { ActionRouter } from "../lib/router.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";

/**
 * Map a raw page-side JS exception message to a VtxError with a code-specific hint.
 * When the auto-IIFE retry path itself fails (e.g. the body has a real syntax
 * error inside a `return` statement), surface that explicitly so callers know
 * the wrapper already tried.
 */
function jsExecutionError(message: string): ReturnType<typeof vtxError> {
  if (message.includes("Illegal return")) {
    return vtxError(
      VtxErrorCode.JS_EXECUTION_ERROR,
      message,
      undefined,
      {
        hint: "Top-level `return` failed even after auto-IIFE retry. Wrap manually: `(function(){ return ... })()` or check the body for a real syntax error inside the return expression.",
      },
    );
  }
  return vtxError(VtxErrorCode.JS_EXECUTION_ERROR, message);
}

export function registerJsHandlers(router: ActionRouter): void {
  router.registerAll({
    [JsActions.EVALUATE]: async (args, tabId) => {
      const code = args.code as string;
      if (!code) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: code");
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        // Auto-IIFE: top-level `return` is illegal in script context. When eval()
        // throws "Illegal return statement", retry through `new Function(code)`
        // which accepts a function body (return allowed). Transparent to caller;
        // sets autoIIFE: true so the dispatcher can surface it in telemetry.
        // Trusted Types: 页面启用 `require-trusted-types-for 'script'`(Google 系
        // 站点普遍)时,裸字符串 eval/new Function 被 CSP 拒。用命名 policy 把代码
        // 包成 TrustedScript 再求值即可绕过(策略创建受页面 trusted-types 指令约束,
        // 失败则优雅回退抛原错——不比现状更糟)。
        func: (c: string) => {
          const g = globalThis as unknown as {
            trustedTypes?: { createPolicy?: (n: string, r: { createScript: (s: string) => string }) => { createScript: (s: string) => string } };
            __vortexTTPolicy?: { createScript: (s: string) => string } | null;
          };
          // 只认 CSP 拒绝的特征短语「Trusted(Type|Script) … assignment」,精确覆盖
          // Chrome 两种真实 sink 措辞:"violates this document's Trusted Type
          // assignment requirements" 与 "requires 'TrustedScript' assignment"。
          // 不匹配裸词,避免用户代码里恰含 "trusted type" 的普通错误被误路由到
          // policy 重试导致副作用代码二次执行(review #2)。
          const isTT = (m: string) =>
            /Trusted ?(Type|Script)[^.]*assignment/i.test(m);
          const getPolicy = () => {
            if (g.__vortexTTPolicy !== undefined) return g.__vortexTTPolicy;
            const tt = g.trustedTypes;
            try {
              g.__vortexTTPolicy =
                tt && typeof tt.createPolicy === "function"
                  ? tt.createPolicy("vortex-eval", { createScript: (s) => s })
                  : null;
            } catch { g.__vortexTTPolicy = null; }
            return g.__vortexTTPolicy;
          };
          try {
            try { return { result: eval(c) }; }
            catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              const p = isTT(m) ? getPolicy() : null;
              if (p) return { result: eval(p.createScript(c) as unknown as string) };
              throw err;
            }
          }
          catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Illegal return")) {
              try {
                try {
                  const fn = new Function(c);
                  return { result: fn(), autoIIFE: true };
                } catch (e2) {
                  const m2 = e2 instanceof Error ? e2.message : String(e2);
                  const p = isTT(m2) ? getPolicy() : null;
                  if (!p) throw e2;
                  const fn = new Function(p.createScript(c) as unknown as string);
                  return { result: fn(), autoIIFE: true };
                }
              } catch (err2) {
                return { error: err2 instanceof Error ? err2.message : String(err2) };
              }
            }
            return { error: msg };
          }
        },
        args: [code],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string; autoIIFE?: boolean };
      if (res?.error) throw jsExecutionError(res.error);
      return res?.result;
    },

    [JsActions.EVALUATE_ASYNC]: async (args, tabId) => {
      const code = args.code as string;
      if (!code) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: code");
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: async (c: string) => {
          // 见 js.evaluate 注释:Trusted Types 站点上 `new Function(string)` 同被拒,
          // 命名 policy 包成 TrustedScript 后绕过。
          const g = globalThis as unknown as {
            trustedTypes?: { createPolicy?: (n: string, r: { createScript: (s: string) => string }) => { createScript: (s: string) => string } };
            __vortexTTPolicy?: { createScript: (s: string) => string } | null;
          };
          // 只认 CSP 拒绝的特征短语「Trusted(Type|Script) … assignment」,精确覆盖
          // Chrome 两种真实 sink 措辞:"violates this document's Trusted Type
          // assignment requirements" 与 "requires 'TrustedScript' assignment"。
          // 不匹配裸词,避免用户代码里恰含 "trusted type" 的普通错误被误路由到
          // policy 重试导致副作用代码二次执行(review #2)。
          const isTT = (m: string) =>
            /Trusted ?(Type|Script)[^.]*assignment/i.test(m);
          const getPolicy = () => {
            if (g.__vortexTTPolicy !== undefined) return g.__vortexTTPolicy;
            const tt = g.trustedTypes;
            try {
              g.__vortexTTPolicy =
                tt && typeof tt.createPolicy === "function"
                  ? tt.createPolicy("vortex-eval", { createScript: (s) => s })
                  : null;
            } catch { g.__vortexTTPolicy = null; }
            return g.__vortexTTPolicy;
          };
          const src = `return (async () => { ${c} })()`;
          try {
            let fn: () => unknown;
            try { fn = new Function(src) as () => unknown; }
            catch (e0) {
              const m0 = e0 instanceof Error ? e0.message : String(e0);
              const p = isTT(m0) ? getPolicy() : null;
              if (!p) throw e0;
              fn = new Function(p.createScript(src) as unknown as string) as () => unknown;
            }
            return { result: await fn() };
          } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
        },
        args: [code],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string };
      if (res?.error) throw jsExecutionError(res.error);
      return res?.result;
    },

    [JsActions.CALL_FUNCTION]: async (args, tabId) => {
      const name = args.name as string;
      const fnArgs = (args.args as unknown[]) ?? [];
      if (!name) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: name");
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: (fnName: string, fnArgs: unknown[]) => {
          try {
            const fn = (window as any)[fnName];
            if (typeof fn !== "function") return { error: `${fnName} is not a function` };
            return { result: fn(...fnArgs) };
          } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
        },
        args: [name, fnArgs],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string };
      if (res?.error) {
        const code = res.error.endsWith("is not a function")
          ? VtxErrorCode.INVALID_PARAMS
          : VtxErrorCode.JS_EXECUTION_ERROR;
        throw vtxError(code, res.error);
      }
      return res?.result;
    },
  });
}
