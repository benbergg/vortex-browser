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
