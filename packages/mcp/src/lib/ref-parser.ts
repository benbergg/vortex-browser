// packages/mcp/src/lib/ref-parser.ts

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";

// v0.8 dual-format window telemetry. Bare refs `@eN` / `@fNeM` are accepted
// for backward compat but slated for removal in v0.9; track in-session usage
// so the v0.9 cut-over decision is data-driven rather than a guess.
// One stderr warn fires on the first bare ref of a session — visible enough
// for dogfood to notice, quiet enough to not flood. The counter accumulates
// for the lifetime of the MCP process and is exposed through vortex_ping.
let bareRefHits = 0;
let bareRefFirstSeenAt: number | null = null;
let bareRefWarned = false;

function recordBareRefHit(target: string): void {
  bareRefHits++;
  if (bareRefFirstSeenAt === null) bareRefFirstSeenAt = Date.now();
  if (!bareRefWarned) {
    bareRefWarned = true;
    process.stderr.write(
      `[vortex-mcp] bare ref "${target}" used; this format is deprecated and will be rejected in v0.9. Use @<hash>:eN from vortex_observe.\n`,
    );
  }
}

export function getBareRefStats(): { hits: number; firstSeenAt: number | null } {
  return { hits: bareRefHits, firstSeenAt: bareRefFirstSeenAt };
}

export function _resetBareRefStats(): void {
  bareRefHits = 0;
  bareRefFirstSeenAt = null;
  bareRefWarned = false;
}

export type ParsedRef =
  | { kind: "ref"; index: number; frameId: number; hash?: string }
  | { kind: "selector"; selector: string };

// v0.8: dual-format. Hash prefix `<hex>:` is OPTIONAL and always outermost;
// frame prefix `fN` is OPTIONAL and immediately before `eN`. Bare `@eN` and
// `@fNeM` remain accepted (deprecated in v0.9).
const REF_RE = /^@(?:([a-fA-F0-9]{4}):)?(?:f(\d+))?e(\d+)$/;

// v0.5 snapshot-ref shapes that LLMs sometimes emit when guessing at v0.6
// target syntax (e.g. carrying habits from v0.5 vortex_dom_click({index, snapshotId})).
// Reject early with a clear migration hint instead of silently dropping the
// raw string into document.querySelector — that would throw SyntaxError deep
// inside page-side actionability and surface as `null.ok` JS_EXECUTION_ERROR.
const V05_REF_PATTERNS: Array<{ re: RegExp; example: string }> = [
  { re: /^snap_[a-z0-9_]+#\d+$/i, example: "snap_xxx#54" },
  { re: /^#\d+$/, example: "#54" },
  { re: /^\d+$/, example: "54" },
];

// Playwright 定位器语法。LLM 极易把它当通用写法传进来（vortex target 只吃 CSS / @ref），
// 而 querySelector 对这些串抛 SyntaxError → page-side probe 曾把它归成可重试的
// NOT_ATTACHED → 空转满 timeout → 抛 "Element detached from DOM"，把调用方推向
// "时序问题"的反方向（2026-07-29 iPaaS 实战：加 timeout / wait idle 全部无效）。
// 在 MCP 入口拒掉，零 tools/list 字节成本（I15 预算已透支，见 I15 测试注释）。
const PLAYWRIGHT_SYNTAX: RegExp[] = [
  /^\s*(text|role|label|placeholder|alt|title|data-testid|css|xpath|id|nth)\s*=/,
  /^\s*internal:/,
  /^\s*\/\//, // 裸 XPath，LLM 常见误传
  />>/,
  /:has-text\(|:text\(|:text-is\(|:nth-match\(/,
];

// `>>` 与 `:text(` 系列在 CSS 的**结构位置**恒非法（`>>>` deep 组合子早已废弃），
// 只可能作为字面量出现在属性值的引号里。故先把引号内容抠空再匹配，否则
// `[title="下一页 >>"]`、`a[href="/p?q=a>>b"]` 这类合法选择器会被判成 Playwright
// 语法并硬失败——中文后台的分页/面包屑文案用 `>>` 作分隔符很常见（审计实证）。
function stripQuotedValues(input: string): string {
  return input.replace(/'[^']*'|"[^"]*"/g, "''");
}

// 把界面文案当 target 传（"保存配置"）——语法上是合法的类型选择器，不抛 SyntaxError，
// extension 层只能报 NOT_ATTACHED 无从分辨，只有此处能拦。
//
// 判据三条同时成立：含非 ASCII、无任何 CSS 结构符、不含连字符。
// 连字符这条是必需的：HTML Standard 的 PotentialCustomElementName 只要求**首字符**
// 是 ASCII 小写字母，后续 PCENChar 允许 [#x3001-#xD7FF] 等大段非 ASCII，且自定义元素名
// **强制含 `-`**。实测 customElements.define("x-中文") 被接受、querySelector("x-中文")
// 能命中真实元素，所以"含非 ASCII 就恒不匹配"是错的，必须放行 x-中文 / my-组件 / x-über。
//
// 写成两次线性 test 而非单条正则：原 /^A*B A*$/ 里 A ⊇ B 完全重叠，是二次回溯
// (实测 20k 字符 5.5s、40k 字符 22s)，而触发形态恰是本规则要拦的输入——整段中文文案
// 不含空格、末尾一个 ASCII 标点即让匹配失败并全量回溯。MCP server 单线程，一次卡死
// 期间所有工具调用全挂。线性化后 40k 字符 ~1ms，无需再给 target 设长度上限。
const HAS_NON_ASCII = /[^\x00-\x7F]/;
const HAS_CSS_STRUCTURE = /[\s.#[\]():>+~,*='"]/;

function looksLikeUiText(input: string): boolean {
  return (
    HAS_NON_ASCII.test(input) &&
    !HAS_CSS_STRUCTURE.test(input) &&
    !input.includes("-")
  );
}

const TARGET_SYNTAX_HELP =
  "vortex_act target accepts a CSS selector (e.g. button.save-btn, input[placeholder='Name']) " +
  "or an @ref from vortex_observe. To match by visible text, call vortex_observe and use the ref it returns.";

export function parseRef(input: string): ParsedRef {
  if (input == null || input === "") {
    throw vtxError(VtxErrorCode.INVALID_PARAMS, "target is required");
  }
  if (typeof input !== "string") {
    throw vtxError(
      VtxErrorCode.INVALID_PARAMS,
      `target must be a string (CSS selector or @ref), got ${typeof input}. Descriptor object form (role/name/...) is reserved for v0.6.x.`,
    );
  }
  if (input.startsWith("@")) {
    const m = input.match(REF_RE);
    if (!m) {
      throw vtxError(
        VtxErrorCode.INVALID_PARAMS,
        `invalid ref format: ${input} (expected @eN, @fNeM, @<hash>:eN, or @<hash>:fNeM where hash is 4 hex chars)`,
      );
    }
    const hash = m[1] != null ? m[1].toLowerCase() : undefined;
    const frameId = m[2] != null ? parseInt(m[2], 10) : 0;
    const index = parseInt(m[3], 10);
    return hash !== undefined
      ? { kind: "ref", index, frameId, hash }
      : { kind: "ref", index, frameId };
  }
  for (const { re, example } of V05_REF_PATTERNS) {
    if (re.test(input)) {
      throw vtxError(
        VtxErrorCode.INVALID_PARAMS,
        `target "${input}" looks like a v0.5 snapshot reference (${example}). v0.6 uses @eN / @fNeM — see vortex_observe output for the correct ref per element (e.g. target: "@e54" or "@f1e2").`,
      );
    }
  }
  if (PLAYWRIGHT_SYNTAX.some((re) => re.test(stripQuotedValues(input)))) {
    throw vtxError(
      VtxErrorCode.INVALID_SELECTOR,
      `target "${input}" uses Playwright locator syntax (text= / >> / :has-text()), which is not supported. ${TARGET_SYNTAX_HELP}`,
    );
  }
  if (looksLikeUiText(input)) {
    throw vtxError(
      VtxErrorCode.INVALID_SELECTOR,
      `target "${input}" looks like UI text passed as a selector: it is a bare type selector with no CSS structure and no hyphen, so it can only match a built-in HTML tag name (which is ASCII) — never a custom element (those require a hyphen). ${TARGET_SYNTAX_HELP}`,
    );
  }
  return { kind: "selector", selector: input };
}

export interface ResolvedTargetParam {
  selector?: string;
  index?: number;
  snapshotId?: string;
  frameId?: number;
}

/** 把 `@eN` / CSS 字符串翻译成 extension action 需要的参数组合 */
export function resolveTargetParam(
  target: string,
  activeSnapshotId: string | null,
  activeSnapshotHash: string | null,
  activeTabId?: number | null,
  currentTabId?: number | null,
): ResolvedTargetParam {
  const r = parseRef(target);
  if (r.kind === "selector") return { selector: r.selector };
  if (r.hash === undefined) recordBareRefHit(target);
  if (!activeSnapshotId) {
    throw vtxError(
      VtxErrorCode.STALE_SNAPSHOT,
      "no active snapshot — call vortex_observe first",
    );
  }
  // 缺陷⑤ (2026-06-07 v4 淘宝评测): tabId 维度校验, 防止 bare ref 跨
  // 导航/跨 tab 绕过 v0.8 hash 严判。评审 #1+#3 组合, 适配 MCP 跑在 Node
  // 无 chrome.webNavigation 限制: 不依赖 onCommitted, 只在调用入口比对
  // activeTabId (observe 时记录的) vs currentTabId (本次调用 args.tabId)。
  // 当 currentTabId 已传 + activeTabId 有值 + 不一致 → throw STALE_SNAPSHOT。
  // 即便 ref 自身带 hash (r.hash === activeSnapshotHash), tab 切换后
  // snapshot 仍可能已失效 (淘宝案例: 旧 "@3f5f:e121" 跨导航点中同 index 元素)。
  if (
    currentTabId !== undefined &&
    currentTabId !== null &&
    activeTabId !== undefined &&
    activeTabId !== null &&
    currentTabId !== activeTabId
  ) {
    throw vtxError(
      VtxErrorCode.STALE_SNAPSHOT,
      `Ref bound to snapshot from tab ${activeTabId}, but current tab is ${currentTabId} (tab changed since observe; re-call vortex_observe)`,
    );
  }
  // v0.8 strict check: only when the ref *itself* carries a hash prefix.
  // Bare refs (@eN / @fNeM) skip this check for backward compat
  // (v0.9 deprecates bare refs). Reuses STALE_SNAPSHOT — existing hint
  // in errors.hints.ts already tells the caller to call vortex_observe.
  if (r.hash !== undefined && r.hash !== activeSnapshotHash) {
    throw vtxError(
      VtxErrorCode.STALE_SNAPSHOT,
      "Ref bound to expired snapshot (hash mismatch)",
    );
  }
  return { index: r.index, snapshotId: activeSnapshotId, frameId: r.frameId };
}
