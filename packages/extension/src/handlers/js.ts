import { JsActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";

/**
 * BUG-003: race a promise against a timeout. Only cancels the client-side wait —
 * cannot abort a running page-side func (Chrome MV3 limitation). For true kill,
 * use CDP Runtime.evaluate (cdpEvaluate) which has native timeout.
 *
 * @param promise  The async work to bound
 * @param ms       Timeout in milliseconds
 * @param action   Tool name for error context
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, action: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(vtxError(VtxErrorCode.TIMEOUT,
        `${action} timed out after ${ms}ms (page-side func may still be running; set shorter timeout, simplify code, or use vortex_navigate to clear the tab)`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Detect CDP "Script execution timed out" error (Chrome 99+). */
function isTimeoutError(msg: string): boolean {
  return /Script execution timed out|Timeout/i.test(msg) && /script|evaluate/i.test(msg);
}

function jsTimeoutError(timeoutMs: number): ReturnType<typeof vtxError> {
  return vtxError(VtxErrorCode.TIMEOUT,
    `Script execution timed out after ${timeoutMs}ms (CDP Runtime.evaluate killed page-side)`,
    undefined,
    { hint: "Avoid infinite loops or long-running operations. Set shorter timeout, simplify code, or split into multiple calls." });
}

/**
 * 页面 CSP 禁 `unsafe-eval`(GitHub / Twitter / Shopify / 多数银行 SaaS 普遍)时,
 * 注入 func 内的 eval/new Function 被**直接拒绝**——这与 Trusted Types
 * (require-trusted-types-for)是两套独立机制,命名 policy 救不了(eval 本身不允许)。
 * 据此回退到 CDP Runtime.evaluate。
 *
 * 用 Chrome CSP 拒绝的**完整特征短语**「'unsafe-eval' is not an allowed」而非裸词
 * `unsafe-eval`:后者会把用户代码里恰好抛含 "unsafe-eval" 的普通错误(校验 CSP 串 /
 * linter 规则名 / 诊断信息)误判为 CSP 拒绝,从而把有副作用的 code 经 CDP **二次执行**
 * (与同文件 isTT 收紧精确短语同因,评审 MEDIUM)。覆盖两种真实措辞:
 * "Refused to evaluate a string … because 'unsafe-eval' is not an allowed source" 与
 * "Evaluating a string … because 'unsafe-eval' is not an allowed source"。
 */
function isUnsafeEvalBlocked(msg: string): boolean {
  return /'unsafe-eval' is not an allowed/i.test(msg);
}

/**
 * B3-4 v3.3 (V2 修正):为 vortex_evaluate { async: true } 选择包装形式。
 *  - 表达式 c → `return (async () => (${c}))()`(直接求值;handler 已 await fn(),无需内层 await)
 *  - 语句/含 return → exprSrc 构造期 SyntaxError → 回退 `return (async () => { ${c} })()`(旧契约)
 *
 * ⚠️ 只能在 service worker / node(单测)调用。page-side func 内禁止调用本函数
 *    (chrome.scripting.executeScript 序列化 toString 注入页面,丢模块作用域)。
 *    func 内联同一逻辑(必须同步)。详见 V2 文档 §0.7 + claude-code 审核意见 §0。
 */
export function buildAsyncSrc(c: string): string {
  const stmtSrc = `return (async () => { ${c} })()`;
  const exprSrc = `return (async () => (${c}))()`;
  try {
    new Function(exprSrc);
    return exprSrc;
  } catch {
    return stmtSrc;
  }
}

/**
 * CDP Runtime.evaluate 回退:经 chrome.debugger 求值,**不受页面 CSP 约束**
 * (debugger 级求值绕过 unsafe-eval),与 Playwright 同路。只 attach 不 enable
 * domain(Runtime.evaluate 无需 Runtime.enable)。**求值后不主动 detach**——与
 * mouse/keyboard/dom 的 Input.* CDP 路径一致(它们同样 bare-attach 且常驻不 detach,
 * 调试横幅本就已存在)。曾有「无 domain 即 detach」版本,但 bare-attach 特性 domains
 * 也为空,并发交错时会把对方在途的 CDP 会话误 detach(评审 HIGH 回归);保持 attach
 * 零竞态、零新横幅成本。returnByValue 与 executeScript 序列化语义一致;awaitPromise
 * 兼容同步值与 Promise。抛 Error(由调用方包成 vtxError)。
 *
 * v3.4 BUG-003:加 `timeoutMs` 参数(默认 5000),Chrome 走 `Runtime.evaluate { timeout:true,
 * timeoutMs }` 原生 abort page-side 死循环。这是 CDP 层的真 kill(不像 page-side 路径
 * 只能 race Promise)。handler 收到的错(error 包含 "Script execution timed out")由调用
 * 方按 isTimeoutError 识别后包装为 TIMEOUT 错。
 */
async function cdpEvaluate(
  debuggerMgr: DebuggerManager,
  tabId: number,
  expression: string,
  timeoutMs: number = 5000,
): Promise<unknown> {
  await debuggerMgr.attach(tabId);
  const res = (await debuggerMgr.sendCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: false,
    timeout: true,             // BUG-003: enable CDP timeout
    timeoutMs,                // BUG-003: 实际超时毫秒
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };
  if (res.exceptionDetails) {
    // 用 vtxError 包装满足 I19 no-bare-throw invariant;调用方(isUnsafeEvalBlocked
    // 分支的 catch)按 e.message 重包成 jsExecutionError,VtxError.message 即裸消息,
    // 行为不变。
    throw vtxError(
      VtxErrorCode.JS_EXECUTION_ERROR,
      res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        "CDP Runtime.evaluate failed",
    );
  }
  return res.result?.value;
}

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

/**
 * v3.4 BUG-001 + BUG-005:对 chrome.scripting.executeScript structured clone 丢字段
 * 的 host object 做后处理,转 plain object,LLM 拿得到真实字段。
 *
 * 根因:structured clone 对 DOMRect / CSSStyleDeclaration / Date / Map / Set / TypedArray /
 * NodeList / Attr 等只 copy enumerable own properties,而这些类型的属性多在 prototype 上
 * 的 getter(如 DOMRect.x 是 DOMRect.prototype 上的 accessor),clone 后 fallback 返 `{}`。
 *
 * 修复:
 *   - Date → .toJSON() (ISO string)
 *   - Error → {name, message, stack} plain object
 *   - Map / Set / TypedArray / NodeList → Array.from() (own 索引元素)
 *   - DOMRect / CSSStyleDeclaration / DOMStringMap → for...in 展开(枚举 own + inherited)
 *   - 普通 object/array 递归展开(深度上限 5 防环)
 *
 * ⚠️ handler 侧只走 fallback(主路径 page-side func 内联同一展开,func.toString() 守卫防假绿)。
 * 本函数纯函数可单测,handler 侧调它处理 CDP 回退的 result。
 */
export function normalizeEvaluateResult(value: unknown, depth = 0): unknown {
  const MAX_DEPTH = 5;
  if (depth > MAX_DEPTH) return null;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return undefined;

  // Array
  if (Array.isArray(value)) return value.map((v) => normalizeEvaluateResult(v, depth + 1));

  // Object — 走品牌(brand)路由。**不用 constructor.name**:页面可 wrap/minify 重命名
  // 内置构造器(实测百度 Date.constructor.name="e"),constructor.name 被击穿。
  // Object.prototype.toString 的 [[Class]]/Symbol.toStringTag 品牌不可被重命名,跨 realm 亦稳。
  if (t === "object") {
    const tag = Object.prototype.toString.call(value).slice(8, -1);  // "Date" / "Map" / "Error" / ...

    // BUG-005: Date → ISO string
    if (tag === "Date") {
      const d = value as Date;
      return d.toJSON();
    }

    // BUG-005: Error → plain object (TypeError 等原生子类品牌同为 "Error")
    if (tag === "Error" || (value as { name?: string }).name?.endsWith("Error")) {
      const e = value as Error;
      const out: Record<string, unknown> = { name: e.name, message: e.message };
      if (e.stack) out.stack = e.stack;
      return out;
    }

    // BUG-005: Map / Set / TypedArray / NodeList → Array
    if (tag === "Map" || tag === "Set" || tag === "NodeList") {
      return Array.from(value as Iterable<unknown>).map((v) => normalizeEvaluateResult(v, depth + 1));
    }
    if (tag === "Uint8Array" || tag === "Uint8ClampedArray" ||
        tag === "Int8Array" || tag === "Uint16Array" ||
        tag === "Uint32Array" || tag === "Int16Array" ||
        tag === "Int32Array" || tag === "Float32Array" ||
        tag === "Float64Array" || tag === "BigInt64Array" ||
        tag === "BigUint64Array") {
      return Array.from(value as Iterable<number>).map((v) => normalizeEvaluateResult(v, depth + 1));
    }

    // BUG-001: DOMRect / CSSStyleDeclaration / DOMStringMap → for...in 展开
    // 普通 plain object 也走这条路径(own properties)
    const out: Record<string, unknown> = {};
    for (const k in value as object) {
      // 跳过 Object.prototype 上的字段 (constructor, hasOwnProperty, ...)
      if (Object.prototype.hasOwnProperty.call(Object.prototype, k)) continue;
      try {
        // @ts-expect-error indexed access
        const v = (value as Record<string, unknown>)[k];
        if (typeof v === "function" || typeof v === "symbol") continue;
        out[k] = normalizeEvaluateResult(v, depth + 1);
      } catch {
        // skip inaccessible
      }
    }
    return out;
  }
  return value;
}

export function registerJsHandlers(
  router: ActionRouter,
  debuggerMgr?: DebuggerManager,
): void {
  router.registerAll({
    [JsActions.EVALUATE]: async (args, tabId) => {
      const code = args.code as string;
      if (!code) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: code");
      // BUG-003: validate timeout param
      const timeout = (args.timeout as number | undefined) ?? 5000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS,
          `timeout must be an integer in [1, 60000]; got ${timeout}`);
      }
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // BUG-003: wrap executeScript in race-against-timeout
      // Note: this only cancels the client-side wait, NOT the page-side func execution
      // (Chrome MV3 has no way to abort a running executeScript func). For true kill,
      // use CDP Runtime.evaluate (cdpEvaluate path below).
      const execPromise = chrome.scripting.executeScript({
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
          // BUG-001/005:host object 序列化展开。**必须内联在 func 内部** ——
          // chrome.scripting.executeScript 经 func.toString() 注入页面 MAIN world 时
          // 丢模块作用域,引用模块级 expandHost 会 `expandHost is not defined`(v3.4 回归)。
          // 与 module-level normalizeEvaluateResult 行为一致,须同步改两边;守卫要求源码
          // 不含 "normalizeEvaluateResult" 字符串故这里用独立名 expandHost。
          const expandHost = (v: unknown, d = 0): unknown => {
            const MAX = 5;
            if (d > MAX) return null;
            if (v === null || v === undefined) return v;
            const t = typeof v;
            if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return v;
            if (t === "function" || t === "symbol") return undefined;
            if (Array.isArray(v)) return v.map((x: unknown) => expandHost(x, d + 1));
            if (t === "object") {
              // 品牌路由,不用 constructor.name(页面可重命名,实测百度 Date→"e")。
              const tag = Object.prototype.toString.call(v).slice(8, -1);
              if (tag === "Date") return (v as Date).toJSON();
              if (tag === "Error" || (v as { name?: string }).name?.endsWith("Error")) {
                const e = v as Error;
                const o: Record<string, unknown> = { name: e.name, message: e.message };
                if (e.stack) o.stack = e.stack;
                return o;
              }
              if (tag === "Map" || tag === "Set" || tag === "NodeList") {
                return Array.from(v as Iterable<unknown>).map((x: unknown) => expandHost(x, d + 1));
              }
              if (tag === "Uint8Array" || tag === "Uint8ClampedArray" || tag === "Int8Array" ||
                  tag === "Uint16Array" || tag === "Uint32Array" || tag === "Int16Array" ||
                  tag === "Int32Array" || tag === "Float32Array" || tag === "Float64Array" ||
                  tag === "BigInt64Array" || tag === "BigUint64Array") {
                return Array.from(v as Iterable<number>).map((x: unknown) => expandHost(x, d + 1));
              }
              const o: Record<string, unknown> = {};
              for (const k in v as object) {
                if (Object.prototype.hasOwnProperty.call(Object.prototype, k)) continue;
                try {
                  const vv = (v as Record<string, unknown>)[k];
                  if (typeof vv === "function" || typeof vv === "symbol") continue;
                  o[k] = expandHost(vv, d + 1);
                } catch { /* skip inaccessible */ }
              }
              return o;
            }
            return v;
          };
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
            try { return { result: expandHost(eval(c)) }; }
            catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              const p = isTT(m) ? getPolicy() : null;
              if (p) return { result: expandHost(eval(p.createScript(c) as unknown as string)) };
              throw err;
            }
          }
          catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Illegal return")) {
              try {
                try {
                  const fn = new Function(c);
                  return { result: expandHost(fn()), autoIIFE: true };
                } catch (e2) {
                  const m2 = e2 instanceof Error ? e2.message : String(e2);
                  const p = isTT(m2) ? getPolicy() : null;
                  if (!p) throw e2;
                  const fn = new Function(p.createScript(c) as unknown as string);
                  return { result: expandHost(fn()), autoIIFE: true };
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
      // BUG-003: race executeScript against timeout
      const results = await withTimeout(execPromise, timeout, "js.evaluate");
      const res = results[0]?.result as { result?: unknown; error?: string; autoIIFE?: boolean };
      if (res?.error) {
        // CSP 禁 unsafe-eval 时回退 CDP Runtime.evaluate(仅主 frame——子 frame 需
        // executionContextId 定位,暂不支持,保留原错)。CDP 下 top-level return 同样
        // 非法 → 镜像 page-side 的 auto-IIFE,包成 (function(){...})() 重试。
        if (debuggerMgr && frameId == null && isUnsafeEvalBlocked(res.error)) {
          try {
            return await cdpEvaluate(debuggerMgr, tid, code, timeout);
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (/Illegal return/.test(m)) {
              return await cdpEvaluate(debuggerMgr, tid, `(function(){${code}})()`, timeout);
            }
            if (isTimeoutError(m)) {
              throw jsTimeoutError(timeout);
            }
            throw jsExecutionError(m);
          }
        }
        throw jsExecutionError(res.error);
      }
      return res?.result;
    },

    [JsActions.EVALUATE_ASYNC]: async (args, tabId) => {
      const code = args.code as string;
      if (!code) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: code");
      // BUG-003: validate timeout param
      const timeout = (args.timeout as number | undefined) ?? 5000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS,
          `timeout must be an integer in [1, 60000]; got ${timeout}`);
      }
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // BUG-003: race executeScript against timeout
      const execPromise = chrome.scripting.executeScript({
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
          // B3-4 v3.3 (V2): 表达式 c(无 return)走直接求值形式,语句/含 return 回退函数体形式。
          // 此处不能调用模块级 buildAsyncSrc(序列化丢作用域),内联同一逻辑——须与之同步。
          // 任何 new Function 抛错(SyntaxError / TT / CSP)都保守回退 stmtSrc = 旧行为。
          const stmtSrc = `return (async () => { ${c} })()`;
          const exprSrc = `return (async () => (${c}))()`;
          let src = stmtSrc;
          try { new Function(exprSrc); src = exprSrc; } catch { /* keep stmtSrc */ }
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
      // BUG-003: race executeScript against timeout
      const results = await withTimeout(execPromise, timeout, "js.evaluateAsync");
      const res = results[0]?.result as { result?: unknown; error?: string };
      if (res?.error) {
        // CSP 禁 unsafe-eval 时回退 CDP Runtime.evaluate(仅主 frame)。异步代码包成
        // (async()=>{...})() + awaitPromise,与 page-side 包装一致。
        if (debuggerMgr && frameId == null && isUnsafeEvalBlocked(res.error)) {
          // B3-4 v3.3 (V2 修正):CSP 禁 unsafe-eval 时回退 CDP Runtime.evaluate。
          // Runtime.evaluate 求值 expression:先试表达式形式(支持纯表达式 code,B3-4),
          // 语法错误(语句/含 return)→ 回退函数体 IIFE 形式。镜像 page-side form-selection。
          try {
            return await cdpEvaluate(debuggerMgr, tid, `(async () => (${code}))()`, timeout);
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (/SyntaxError|Unexpected|Illegal return/i.test(m)) {
              try {
                return await cdpEvaluate(debuggerMgr, tid, `(async () => { ${code} })()`, timeout);
              } catch (e2) {
                throw jsExecutionError(e2 instanceof Error ? e2.message : String(e2));
              }
            }
            if (isTimeoutError(m)) {
              throw jsTimeoutError(timeout);
            }
            throw jsExecutionError(m);
          }
        }
        throw jsExecutionError(res.error);
      }
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
