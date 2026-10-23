// 跑一个 case：启 MCP 连接，navigate 到 playground 页面，执行 run(ctx)，收集指标。

import { createMcpConnection, closeMcpConnection, type McpConnection } from "./mcp-client.js";
import { Trace, extractErrorCodes } from "./trace.js";
import type { CaseContext, CaseDefinition, CaseMetrics } from "../types.js";

export interface RunCaseOptions {
  mcpBin: string;
  playgroundUrl: string;
  /**
   * Issue #21 — runner-level arg injection for sweep mode. Merged
   * (shallow, override-wins) into the args of every `ctx.call(name, ...)`
   * whose tool name matches a key. Lets us A/B-compare bench cases under
   * different observe options without mutating per-case fixture files
   * (which would break pass-1 byte parity vs the v0.6 baseline lockdown).
   */
  argOverrides?: Record<string, Record<string, unknown>>;
}

/** Exported for unit tests; production code goes through `ctx.assert`. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Classify a runner-level failure so reporters / CI can separate env breakage
 * from real regression. Patterns are matched in the order listed; the first
 * hit wins. New patterns should preserve the priority (assertion before
 * tool_error, etc.).
 *
 * Exported for unit tests; production callers go through `runCase`.
 */
export function classifyFailure(err: unknown): NonNullable<CaseMetrics["failureClass"]> {
  if (err instanceof AssertionError) return "assertion_failure";
  const msg = err instanceof Error ? err.message : String(err);
  // Env: extension not installed in this URL, native host down, playground unreachable
  if (
    msg.includes("PERMISSION_DENIED") ||
    msg.includes("manifest must request permission") ||
    msg.includes("Cannot access contents of url") ||
    msg.includes("EXTENSION_NOT_CONNECTED") ||
    msg.includes("vortex-server unreachable") ||
    msg.includes("Failed to connect to vortex-server") ||
    msg.includes("ECONNREFUSED")
  ) return "env_failure";
  // Timeout (runner-level or transport-level)
  if (msg.includes("timed out") || msg.includes("TIMEOUT") || msg.includes("Timeout:")) return "timeout";
  // Tool error: `Error [CODE]: ...` shape from vortex-mcp formatError
  if (/^Error \[[A-Z_]+\]:/m.test(msg)) return "tool_error";
  return "unknown";
}

/**
 * B 层 case 三态结局(评测门 P2.2)。优雅降级(evaluate 兜底)是软扣分非硬失败:
 * agent 完成了任务,只是 observe 看不到只能 JS 兜底 → pass-degraded(eval 门据此
 * 既不放过、也不误杀)。passed=false 一律 fail(兜底与否无关)。
 */
export function classifyCaseOutcome(
  m: Pick<CaseMetrics, "passed" | "fallbackToEvaluate">,
): "pass" | "pass-degraded" | "fail" {
  if (!m.passed) return "fail";
  return m.fallbackToEvaluate > 0 ? "pass-degraded" : "pass";
}

export async function runCase(def: CaseDefinition, opts: RunCaseOptions): Promise<CaseMetrics> {
  const mcp = await createMcpConnection({
    command: process.execPath,
    args: [opts.mcpBin],
    env: { ...(process.env as Record<string, string>) },
  });

  const trace = new Trace();
  let callCount = 0;
  let fallback = 0;
  let missed = 0;
  let outputBytes = 0;
  // 防假绿闸门的计数源：ctx.assert 每被调一次 +1（失败的那次也计）。
  let assertionCount = 0;
  const outputBytesByTool: Record<string, number> = {};
  const customMetrics: Record<string, number> = {};

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    callCount++;
    const overrides = opts.argOverrides?.[name];
    const finalArgs = overrides ? { ...args, ...overrides } : args;
    trace.push({ kind: "tool_call", name, args: finalArgs, at: trace.now() });
    const res = await mcp.client.callTool({ name, arguments: finalArgs });
    const text = extractText(res);
    const errorCodes = extractErrorCodes(text);
    // v0.7.1 instrument: 累加 utf-8 字节数（Buffer.byteLength 比 .length 准——
    // 中文 3 倍）。LLM token 估算用 bytes/4 粗算或专用 tokenizer。
    const bytes = Buffer.byteLength(text, "utf-8");
    outputBytes += bytes;
    outputBytesByTool[name] = (outputBytesByTool[name] ?? 0) + bytes;
    trace.push({
      kind: "tool_result",
      name,
      isError: Boolean((res as { isError?: boolean }).isError),
      resultText: text,
      errorCodes,
      at: trace.now(),
    });
    return res;
  }

  const ctx: CaseContext = {
    playgroundUrl: opts.playgroundUrl,
    async call(name, args) {
      return callTool(name, args);
    },
    async fallbackEvaluate(args) {
      fallback++;
      return callTool("vortex_evaluate", args as unknown as Record<string, unknown>);
    },
    recordObserveMiss(n) {
      missed += n;
    },
    assert(cond, message) {
      // 计数先于抛错：失败的那次断言同样是"这个用例做过断言"的证据，
      // 只在通过时计数会让"断言失败"的用例被误判成零断言。
      assertionCount++;
      if (!cond) throw new AssertionError(message);
    },
    recordMetric(key, value) {
      customMetrics[key] = value;
    },
  };

  const started = Date.now();
  try {
    let passed = false;
    let reason: string | undefined;
    let failureClass: CaseMetrics["failureClass"];
    try {
      // 每个 case 开头固定动作：先 about:blank 卸载旧组件，再 navigate 到目标
      // （同 URL navigate 在 Vue hash router 下不会重 mount，导致跨次 state 残留）
      await ctx.call("vortex_navigate", { url: "about:blank" });
      await ctx.call("vortex_navigate", {
        url: opts.playgroundUrl + def.playgroundPath,
      });
      await ctx.call("vortex_wait_for", {
        mode: "idle",
        value: "dom",
        timeout: 5000
      });

      await def.run(ctx);

      passed = true;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      failureClass = classifyFailure(err);
    }

    const m = buildMetrics(def, passed, reason, failureClass, callCount, fallback, missed, outputBytes, outputBytesByTool, Date.now() - started, customMetrics);
    m.assertionCount = assertionCount;

    // 两个比率指标：分母为 0 时不写入（保持 report 形状稳定）
    const derived = computeDerivedMetrics(trace);
    if (derived.hintPresentRate !== undefined) m.hintPresentRate = derived.hintPresentRate;
    if (derived.refReuseRate !== undefined) m.refReuseRate = derived.refReuseRate;

    // 防假绿闸门：用例"跑完了但一条断言都没做"——验了等于没验，判失败。
    // 只在用例正常结束（passed=true）时判；已经失败的用例保留自己的 failureClass
    // （env_failure / tool_error / timeout 不能被 assertion_failure 掩盖）。
    if (passed && assertionCount === 0) {
      m.passed = false;
      m.failureClass = "assertion_failure";
      m.failureReason ??= "用例未产生任何断言（防假绿闸门）";
    }
    return m;
  } finally {
    await closeMcpConnection(mcp);
    void trace; void mcp as unknown as McpConnection; // 保留引用抑制 unused 警告
  }
}

/**
 * 从 trace 事件算两个比率指标（口径见 types.ts 的字段注释）。
 * 分母为 0 的指标直接不返回 —— 调用方据此不写字段，保持 report 形状稳定。
 *
 * - hintPresentRate：分母 = 有错误/诊断文本的调用数，分子 = 其中文本带 hint 的调用数
 * - refReuseRate：分母 = 参数顶层 target 是非空字符串的调用数，分子 = 其中 target 以 @ 开头的
 */
export function computeDerivedMetrics(trace: Trace): { hintPresentRate?: number; refReuseRate?: number } {
  let errorCalls = 0;
  let errorCallsWithHint = 0;
  let targetCalls = 0;
  let refTargetCalls = 0;

  for (const ev of trace.events) {
    if (ev.kind === "tool_result") {
      if (!isErrorResult(ev)) continue;
      errorCalls++;
      if (/hint/i.test(ev.resultText)) errorCallsWithHint++;
    } else if (ev.kind === "tool_call") {
      const target = readTarget(ev.args);
      if (target === undefined) continue;
      targetCalls++;
      if (target.startsWith("@")) refTargetCalls++;
    }
  }

  const out: { hintPresentRate?: number; refReuseRate?: number } = {};
  if (errorCalls > 0) out.hintPresentRate = errorCallsWithHint / errorCalls;
  if (targetCalls > 0) out.refReuseRate = refTargetCalls / targetCalls;
  return out;
}

/** 这次调用算不算"错误/诊断文本"：MCP 的 isError 标记、错误码、或 `Error [CODE]:` 形状任一命中。 */
function isErrorResult(ev: { isError: boolean; errorCodes: string[]; resultText: string }): boolean {
  if (ev.isError) return true;
  if (ev.errorCodes.length > 0) return true;
  return /^Error \[[A-Z_]+\]:/m.test(ev.resultText);
}

/** 读调用参数顶层的 target（非空字符串才算"带 target 的调用"；null/缺省=整页，不计）。 */
function readTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const target = (args as { target?: unknown }).target;
  if (typeof target !== "string" || target.length === 0) return undefined;
  return target;
}

function buildMetrics(
  def: CaseDefinition,
  passed: boolean,
  reason: string | undefined,
  failureClass: CaseMetrics["failureClass"],
  callCount: number,
  fallback: number,
  missed: number,
  outputBytes: number,
  outputBytesByTool: Record<string, number>,
  durationMs: number,
  customMetrics: Record<string, number>,
): CaseMetrics {
  const m: CaseMetrics = {
    case: def.name,
    passed,
    callCount,
    fallbackToEvaluate: fallback,
    observeMissedPopperItems: missed,
    outputBytes,
    durationMs,
  };
  if (Object.keys(outputBytesByTool).length > 0) m.outputBytesByTool = { ...outputBytesByTool };
  if (reason !== undefined) m.failureReason = reason;
  if (failureClass !== undefined) m.failureClass = failureClass;
  if (Object.keys(customMetrics).length > 0) m.customMetrics = { ...customMetrics };
  if (def.tier !== undefined) m.tier = def.tier; // 评测门 P2.2:透传难度档供 eval 分档聚合
  return m;
}

function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item) {
      parts.push(String((item as { text: unknown }).text));
    }
  }
  return parts.join("\n");
}
