/**
 * instructions 生成器：把 `contract.ts` 的契约单一真值渲染成 MCP server 下发的正文。
 *
 * 为什么需要它：ref 的跨快照语义、fill 的值形状、query 的 mode 边界……
 * 这些"必须靠猜才知道"的约束以前只活在源码注释里，模型看不到。
 * 放进 tool description 会和 instructions 各说各话并逐渐漂移；放进 instructions
 * 则由 server 在握手时同源下发，契约改一处即可（见 contract.ts）。
 *
 * 单一真值约束（重要）：
 * - 逐字必须串**只存在于 contract.ts**。本文件的散文说明里不得再抄一份，
 *   正文靠 `{{must}}` 占位符在渲染时插入 `ContractItem.mustInclude` 的真值。
 *   ⇒ 改了 contract.ts 的逐字串，instructions 正文自动跟随，无需手工同步。
 *   （护栏：tests/instructions-e2e.test.ts 的两条 source-lock / 探针用例。）
 *
 * 硬约束：
 * - 正文**全中文**；**不写工具清单**（工具清单由 `tools/list` 负责，避免重复占体积）。
 * - 首尾必须有哨兵（`SENTINEL_PREFIX` / `SENTINEL_SUFFIX`）+ 版本号：
 *   消费端缺首或缺尾即判定正文被截断，应分片读取（见 contract.ts 注释）。
 * - 体积受 `INSTRUCTIONS_TOKEN_BUDGET` 约束（由测试守住）。
 * - 本模块**不引入任何依赖**（纯字符串拼装）。
 */

import {
  CONTRACT_ITEMS,
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  type ContractItem,
} from "./contract.js";

/** 正文里插入逐字必须串的占位符：渲染时替换成该条契约的 mustInclude 真值。 */
const MUST_SLOT = "{{must}}";

/**
 * 工作流速览（≤ 5 行）：先给模型一条"该按什么顺序干活"的骨架，
 * 细节约束逐条列在下面的契约要点里。
 *
 * 注意：这里**不写**逐字必须串（单一真值只在 contract.ts），
 * 工具名按需出现即可（observe 工具的名字由 workflow 那条契约的正文给出）。
 */
const WORKFLOW_OVERVIEW: readonly string[] = [
  "1. 先观察页面拿到元素 ref，再 vortex_act 操作；不要盲点。",
  "2. ref 失效就重新观察换新 ref，别拿旧 ref 反复硬试。",
  "3. 下结论前先取证：动作效果信号、vortex_extract 的文本、vortex_debug_read 的网络与控制台输出。",
  "4. 取不到证据就用 vortex_query 探测页面结构，而不是重复同一个动作。",
];

/**
 * 10 条契约要点的散文说明（key 与 contract.ts 的 key 一一对应）。
 *
 * 说明里**不含**任何逐字必须串：`{{must}}` 会在渲染时被该条契约的
 * `mustInclude` 真值替换掉。因此改 contract.ts 的逐字串时，正文自动跟随。
 */
const DETAILS: Record<string, string> = {
  workflow:
    "先用 {{must}} 看清当前页面与可点元素，再动手操作；拿到的 ref 失效就重新再看，别凭空编 ref。",
  "ref-lifecycle":
    "带 hash 的 ref（形如 {{must}}）也不跨快照复用：重新 observe 后请重新取得 ref；旧 hashed ref 会被明确拒绝（STALE_SNAPSHOT），不会静默指向别的元素。裸 ref 只绑定当前快照且已废弃。",
  "fill-value-shape":
    "值形状随控件变：普通输入框给字符串，日期区间控件需 {{must}}，级联选择器需逐级路径数组。填错时按错误信息里给出的正确形状重填。",
  "query-mode-boundary":
    "sheet 模式只认 {{must}}，不认普通 DOM table（普通表格改用 vortex_extract）；component 模式返回 Vue 实例/props，selector 仍是 CSS。",
  "wait-for-modes":
    "各 mode 含义不同：element 等元素出现（value 是 CSS 选择器）；idle 等空闲（value=network|xhr|dom）；{{must}} 返回页面信息概览（默认含全部标签页）；custom 轮询 JS 表达式直到为真。",
  "screenshot-target":
    "target 可传 observe 给的 @ref，也可传 {{must}}；省略或传 null 表示整页截图。",
  "extract-truncation":
    "超长会截断并带 {{must}} 标记；要全文就缩小范围或分段取，别把截断当完整内容。",
  "debug-read-params":
    "filter 是平铺键，不要按 source 再嵌一层：console 用 level，network 用 pattern 必填，并用 {{must}} 与 statusMax 过滤 HTTP 状态码区间；tail=N 取最近 N 条。",
  "effect-signals":
    "act 返回的信号（{{must}}、domMutations、networkRequests 等）只是观察到的证据；全阴性只说明没观察到阳性信号，不等于操作一定没生效。",
  "path-case":
    "hash 路由大小写敏感（{{must}} 与其大小写变体不是同一条）；页面打得开不等于应用内路由存在，可能落到空状态页。",
};

/**
 * 渲染一条契约要点的正文：把散文说明里的占位符换成该条契约的逐字必须串。
 *
 * 兜底：新增契约要点若忘了写散文说明，至少保证其逐字串仍然进入 instructions
 * （契约不丢）；散文说明是新增要点时的应有动作。
 *
 * @param item 契约要点
 * @param template 散文说明模板；`null` 表示"这条没有写散文说明"，
 *   渲染退化成只输出逐字串（护栏测试用它验证"删掉说明 ⇒ 整句限制语句消失"）。
 */
export function renderDetail(item: ContractItem, template: string | null = DETAILS[item.key] ?? null): string {
  const must = item.mustInclude.join("、");
  if (!template) return must;
  return template.includes(MUST_SLOT)
    ? template.replaceAll(MUST_SLOT, must)
    : `${template}${must}`;
}

/**
 * 生成 MCP server 下发的 instructions 正文。
 *
 * @param version 版本号（由调用方传入，通常是 MCP server 自身的版本）。
 * @returns 带首尾哨兵与版本号的正文文本。
 */
export function buildInstructions(version: string): string {
  const lines: string[] = [];
  lines.push(`${SENTINEL_PREFIX}${version}`);
  lines.push("使用契约：");
  lines.push(...WORKFLOW_OVERVIEW);
  lines.push("契约要点：");
  for (const item of CONTRACT_ITEMS) {
    lines.push(`- ${item.title}：${renderDetail(item)}`);
  }
  lines.push(`${SENTINEL_SUFFIX}${version}`);
  return lines.join("\n");
}
