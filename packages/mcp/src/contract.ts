/**
 * 契约单一真值（Single source of truth）。
 *
 * 背景：Vortex 的公开工具面里散落着"必须靠猜才知道"的契约——ref 的跨快照语义、
 * fill 的值形状、query 的 mode 边界、extract 的截断标记……以前这些只写在源码注释里，
 * 模型看不到；真放到 tool description 里又会和 instructions 各说各话、逐渐漂移。
 *
 * 本模块把这些要点收成一处**版本化**清单：
 * - `CONTRACT_ITEMS`：10 条要点，每条带 `mustInclude` 逐字必须串
 *   （谁删掉这些串，护栏测试就红 —— 见 tests/contract-gate.test.ts）。
 * - `SENTINEL_PREFIX` / `SENTINEL_SUFFIX`：instructions 首尾哨兵，
 *   缺失即被消费端截断，消费方应分片读取。
 * - `INSTRUCTIONS_TOKEN_BUDGET`：instructions 正文体积上限（结构化估算口径）。
 * - `estimateTokens`：体积估算函数。
 *
 * 消费方（不许各写各的）：
 * - Task 2 的 `instructions.ts` 由本模块生成 instructions 正文（server 同源下发）。
 * - Task 3/4 的 CLI 契约测试从本模块取逐字串。
 *
 * 本模块**不引入任何依赖、不读环境变量**（纯常量 + 纯函数），
 * 以免契约真值随运行时环境漂移。
 */

/** 一条契约要点。`mustInclude` 是该要点必须出现的逐字串（护栏断言的对象）。 */
export interface ContractItem {
  /** 稳定标识（顺序即 instructions 中的呈现顺序，改动视为破坏契约）。 */
  key: string;
  /** 人类可读标题，作为 instructions 里的要点标题。 */
  title: string;
  /** 该要点必须逐字出现的串（至少一条）。删掉即视为契约破损。 */
  mustInclude: readonly string[];
}

/**
 * 契约清单：设计稿 §五 D1 的 10 条要点。
 *
 * 逐字串取自"真实踩坑"而非泛泛介绍：
 * - `workflow`：先 observe 拿 ref 再 act，不要盲点。
 * - `ref-lifecycle`：带 hash 的 ref 跨快照身份稳定，裸 ref 只绑定当前快照。
 * - `fill-value-shape`：fill 的值形状随 widget 变（daterange 需 {start,end}）。
 * - `query-mode-boundary`：sheet 只认 Lake Sheet，component 返回 Vue 实例/props。
 * - `wait-for-modes`：mode=info 等自由文本 mode 的含义。
 * - `screenshot-target`：target 可传 ref 也可传 CSS selector。
 * - `extract-truncation`：超长截断并带 [VORTEX_TRUNCATED] 标记。
 * - `debug-read-params`：filter 的 statusMin/statusMax 是 HTTP 状态码区间过滤。
 * - `effect-signals`：阴性 = 未观察到任何阳性信号，不等于"一定没生效"。
 * - `path-case`：路径大小写敏感；导航成功不等于应用路由存在。
 */
export const CONTRACT_ITEMS: readonly ContractItem[] = [
  {
    key: "workflow",
    title: "工作流骨架：先 vortex_observe 拿 ref，再 vortex_act 操作，不要盲点",
    mustInclude: ["vortex_observe"],
  },
  {
    key: "ref-lifecycle",
    title: "ref 语义与生命周期：跨快照只用带 hash 的 ref，失效后重新 observe",
    mustInclude: ["@<hash>:eN"],
  },
  {
    key: "fill-value-shape",
    title: "vortex_fill 的值形状按 widget 走，错误信息里带正确形状",
    mustInclude: ["{start,end}"],
  },
  {
    key: "query-mode-boundary",
    title: "vortex_query 各 mode 的语义边界（sheet 只认 Lake Sheet，component 返回 Vue 实例/props）",
    mustInclude: ["Lake Sheet"],
  },
  {
    key: "wait-for-modes",
    title: "vortex_wait_for 各 mode 的含义与适用场景",
    mustInclude: ["mode=info"],
  },
  {
    key: "screenshot-target",
    title: "vortex_screenshot 的 target 可传 ref 也可传 CSS selector",
    mustInclude: ["CSS selector"],
  },
  {
    key: "extract-truncation",
    title: "vortex_extract 超长会截断并带标记，分段取全文",
    mustInclude: ["[VORTEX_TRUNCATED]"],
  },
  {
    key: "debug-read-params",
    title: "vortex_debug_read 的 filter 子键语义与默认输出量",
    mustInclude: ["statusMin"],
  },
  {
    key: "effect-signals",
    title: "effect 信号判读：阴性 = 未观察到任何阳性信号，不等于一定没生效",
    mustInclude: ["urlChanged"],
  },
  {
    key: "path-case",
    title: "路径大小写敏感；导航成功不等于应用路由存在",
    mustInclude: ["/#/el-cascader"],
  },
];

/** instructions 正文体积上限（按 `estimateTokens` 的结构化估算口径计）。 */
export const INSTRUCTIONS_TOKEN_BUDGET = 1200;

/** instructions 首哨兵前缀（带版本 stamp，缺首即视为截断）。 */
export const SENTINEL_PREFIX = "[vortex:instructions] ";

/** instructions 尾哨兵前缀（带版本 stamp，缺尾即视为截断）。 */
export const SENTINEL_SUFFIX = "[vortex:instructions] end ";

/**
 * 结构化 token 估算：**不是精确 tokenizer**，只是可复现的体积口径。
 *
 * 口径（与设计稿 §五 D6 一致）：
 * - 中文/全角（含 CJK、标点、全角符号等码位 > 0x2E80）按 1 字 1 token 计；
 * - 其余（ASCII）按 4 字符 1 token 计，向上取整。
 *
 * 用途：给 instructions 正文做体积闸门（`INSTRUCTIONS_TOKEN_BUDGET`），
 * 让"超预算即 CI 失败"这条规则有可测口径。真实分词结果与本估算会有偏差，
 * 引用本函数时必须说明它是估算。
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let ascii = 0;
  // 按码点遍历：代理对（emoji 等）算 1 个码点，不被拆成两个字符。
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x2e80) wide += 1;
    else ascii += 1;
  }
  return wide + Math.ceil(ascii / 4);
}
