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
  /** 评测门 P2.1：难度档，从 CaseDefinition.tier 透传，eval 报告分档聚合用。 */
  tier?: "easy" | "medium" | "hard";
  /**
   * 本次运行实际产生的断言次数（ctx.assert 调用数，失败的那次也计入）。
   * 0 = 这个用例一条断言都没做 → 防假绿闸门把它判成 assertion_failure
   * （"跑完了但什么都没验"是最危险的假绿）。
   */
  assertionCount?: number;
  /**
   * 有错误/诊断文本的工具调用里，错误文本带 hint 的比例 ∈ [0, 1]。
   * 口径：分母 = 有错误文本的调用数（isError / 错误码 / `Error [CODE]:` 形状任一命中）；
   * 分子 = 其中文本里出现 hint 的调用数。
   * 分母为 0（本次运行没有任何错误文本）时本字段**不写入**（保持 report 形状稳定），
   * 于是"字段存在"即表示"本次有错误"，字段值不会被"无错误"稀释。
   */
  hintPresentRate?: number;
  /**
   * 带 target 的调用里，target 形如 @ref（以 @ 开头）的比例 ∈ [0, 1]。
   * 口径：分母 = 参数顶层 target 是非空字符串的调用数（vortex_act / vortex_fill /
   * vortex_observe / vortex_screenshot / vortex_extract / vortex_drag 等）；
   * 分子 = 其中 target 以 @ 开头的调用数（@e3 / @f1e2 / @<hash>:eN 等）。
   * 分母为 0（本次运行没有任何带 target 的调用）时本字段**不写入**。
   */
  refReuseRate?: number;
  /**
   * 用例所属套件（从 CaseDefinition.suite 透传，缺省视为 "a"）。
   * 报告里按它分档：suite A = 既有组件库用例（依赖 playground），
   * suite B = 自包含的失败路径用例（依赖进程内 fixture）。
   */
  suite?: "a" | "b";
}

export interface CaseContext {
  /**
   * Playground 基础 URL（runner 真值源，来自 opts.playgroundUrl）。
   * case 中途需要重新 navigate 时优先用此字段，避免每个 case 自读
   * process.env 导致 env 名漂移。
   */
  readonly playgroundUrl: string;
  /**
   * 本条用例的**基址**：suite A 等于 playgroundUrl，suite B 等于自包含 fixture 的 URL。
   * suite B 的用例自包含（不依赖 vite playground），一律用此字段导航；
   * suite A 的用例两者同值，可继续用 playgroundUrl。
   */
  readonly baseUrl: string;
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
  /**
   * playground 路由路径，e.g. '/#/el-dropdown'；synth 任务指向 '/synth/<snapshot>.html'。
   * suite B（自包含用例）**省略**此字段 —— 它们的基址来自 ctx.baseUrl（fixture URL）。
   */
  playgroundPath?: string;
  /**
   * 用例套件归属，缺省视为 "a"。A 层 = 组件能力基线，B 层 = 端到端任务。
   * bench CLI 的 `--suite a|b|all` 按本字段过滤（读 def.suite，不靠文件名约定）。
   */
  suite?: "a" | "b";
  /** 难度档，与 SynthManifest.tier 对齐；eval 命令按此分档聚合任务通过率。缺省视为 medium。 */
  tier?: "easy" | "medium" | "hard";
  /** 绑定的 synth 快照名（A 层 scan 与 B 层 task 同指一份冻结快照，便于交叉分诊）。 */
  snapshot?: string;
  run(ctx: CaseContext): Promise<void>;
}

export interface BenchReport {
  generatedAt: string;
  playgroundUrl: string;
  /**
   * suite B 自包含 fixture 的基址（仅当本次运行启动了 fixture 时写入）。
   * 报告里 suite B 的用例独立成组，其导航基址就是它（不是 playgroundUrl）。
   */
  fixtureUrl?: string;
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
