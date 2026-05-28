// FILL_REJECT_PATTERNS page-side check (IIFE, attaches to window.__vortexFillReject).
// Migrated from dom.ts FILL handler page-side func (framework-aware rejection block).
//
// FILL_REJECT_PATTERNS (from patterns/fill-reject.ts) identifies framework-controlled
// components (e.g. Element Plus, Ant Design). When fill writes .value the framework reverts
// it; caller should use vortex_dom_commit instead.
//
// Detection: el.closest(p.closestSelector) — faithful copy of original dom.ts page-side logic.
// `patterns` is injected by the host-side at call time; this module does not persist them.

// Tier 2：shadow-internal 元素 light-DOM querySelector 找不到，用 queryDeep 兜底。
// 不走 window.__vortexDomResolve，避免加载顺序依赖（与 actionability.ts 同策略）。
import { queryDeep } from "./shadow-walk.js";

(function () {
  if ((window as any).__vortexFillReject?.version === 1) return;

  type FillRejectPattern = {
    id: string;
    closestSelector: string;
    reason: string;
    suggestedTool: string;
    fixExample: string;
  };

  type RejectResult =
    | { rejected: false }
    | {
        rejected: true;
        errorCode: string;
        error: string;
        extras: Record<string, unknown>;
      };

  /**
   * Check whether the element matched by `sel` is hit by any reject pattern.
   * Mirrors the original dom.ts FILL page-side func "framework-aware rejection" block.
   * Only called when `allowFallback` is false (same guard as dom.ts).
   *
   * Returns `{ rejected: false }` when no pattern matches, or a rejection payload
   * containing errorCode/error/extras (same shape as dom.ts page-side return value).
   */
  function checkRejectPattern(
    sel: string,
    rejectPatterns: FillRejectPattern[],
  ): RejectResult {
    // light-DOM 优先；落空时穿 open shadow 兜底，处理 Tier 2 shadow-internal ref 目标。
    let el: HTMLElement | null;
    try {
      el = (document.querySelector(sel) ?? queryDeep(sel, document)) as HTMLElement | null;
    } catch {
      // 无效 CSS 选择器（如裸快照 ref）——视为未匹配，直接跳过守卫。
      el = null;
    }
    if (!el) return { rejected: false };

    for (const p of rejectPatterns) {
      let hit = false;
      try {
        hit = !!el.closest(p.closestSelector);
      } catch {
        // invalid selector — skip
      }
      if (hit) {
        return {
          rejected: true,
          errorCode: "UNSUPPORTED_TARGET",
          error:
            `dom_fill rejected on framework-controlled target (${p.id}): ${p.reason} ` +
            `Retry with ${p.suggestedTool}. Example: ${p.fixExample}`,
          extras: {
            pattern: p.id,
            suggestedTool: p.suggestedTool,
            fixExample: p.fixExample,
            selector: sel,
          },
        };
      }
    }
    return { rejected: false };
  }

  (window as any).__vortexFillReject = {
    version: 1,
    checkRejectPattern,
  };
})();

export {};
