// vortex-bench v0.6 公共类型
// case 定义 + 运行指标 + diff 结构

export interface CaseMetrics {
  /** case 名，等于 cases/<name>.case.ts */
  case: string;
  passed: boolean;
  /** 工具调用总次数（含 fallback） */
  callCount: number;
  /** evaluate 兜底次数：case 作者显式标记 "observe 看不到只能用 JS 兜底" */
  fallbackToEvaluate: number;
  /** observe 本应捕捉但漏掉的 popper / teleport 项数量 */
  observeMissedPopperItems: number;
  durationMs: number;
  /**
   * v0.7.1 新增：tool result text 累计字节数（utf-8 length 加和）。
   * 反映 LLM 上下文消耗——比 callCount 更直接的成本指标。
   */
  outputBytes: number;
  /** v0.7.1 新增：按工具名拆分的 outputBytes，用于看哪些 tool 是 token hog */
  outputBytesByTool?: Record<string, number>;
  failureReason?: string;
  /**
   * v0.8.x 新增：失败分类。让 ship-preflight / CI 能区分"环境问题"和
   * "真 regression"——v0.8 之前所有失败用同一 string 字段，env 失败
   * （例如 chrome-extension PERMISSION_DENIED）跟 assertion 失败混在
   * 一起，掩盖真 regression。
   * - assertion_failure: case 自己的 ctx.assert / assertResultContains 抛错
   * - env_failure: 扩展未注入/未授权、playground 不在线、native host 未就绪
   * - tool_error: 工具返回 `Error [CODE]:` 形式（INVALID_PARAMS / STALE_SNAPSHOT 等）
   * - timeout: 上层 Promise 超时（≥ 30s 无响应）
   * - unknown: 兜底（未来 caller 看到 unknown 即提 PR 加分类规则）
   * passed=true 时此字段缺省。
   */
  failureClass?: "assertion_failure" | "env_failure" | "tool_error" | "timeout" | "unknown";
  /**
   * v0.8.x 新增：N-run aggregation metadata.
   * - `repeats`: how many times this case was actually run (only set when >1).
   * - `passRate`: passed_runs / repeats ∈ [0, 1]. `passed=true` iff `passRate >= 0.5`
   *   (majority-pass policy — tolerates single-flake but surfaces borderline cases
   *   via `passRate=0.67`). Other numeric fields hold the MEDIAN across the N runs.
   * Both fields absent when repeats=1 so single-shot runs keep byte-identical
   * report shape with v0.8 baseline.
   */
  repeats?: number;
  passRate?: number;
  /** v0.6 新增：case 自定义数值指标（如 P50/P90 延迟、token baseline 等） */
  customMetrics?: Record<string, number>;
}

export interface CaseContext {
  /**
   * Playground 基础 URL（runner 真值源，来自 opts.playgroundUrl）。
   * case 中途需要重新 navigate 时优先用此字段，避免每个 case 自读
   * process.env 导致 env 名漂移。
   */
  readonly playgroundUrl: string;
  /** 直接调 MCP 工具，自动计数 callCount */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** evaluate 兜底，callCount++ 且 fallbackToEvaluate++ */
  fallbackEvaluate(args: { frameId?: number; code: string; async?: boolean }): Promise<unknown>;
  /** 记录 observe 漏项数量（case 作者手动对比预期 vs 实际） */
  recordObserveMiss(missed: number): void;
  /** 断言失败即 throw，runCase 捕获置为 failed */
  assert(cond: unknown, message: string): void;
  /** v0.6 新增：写入 customMetrics 字段（被框架收集到 CaseMetrics） */
  recordMetric(key: string, value: number): void;
}

export interface CaseDefinition {
  name: string;
  /** playground 路由路径，e.g. '/#/el-dropdown' */
  playgroundPath: string;
  run(ctx: CaseContext): Promise<void>;
}

export interface BenchReport {
  generatedAt: string;
  playgroundUrl: string;
  cases: CaseMetrics[];
}

export type Severity = "ok" | "warning" | "critical";

export interface MetricDiff {
  metric: keyof CaseMetrics;
  before: number | boolean;
  after: number | boolean;
  delta: number;
  severity: Severity;
}

export interface CaseDiff {
  case: string;
  status: "added" | "removed" | "unchanged" | "regressed" | "improved";
  changes: MetricDiff[];
}
