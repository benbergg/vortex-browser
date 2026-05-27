// Page-side Actionability 6-probe checks (IIFE, attaches to window.__vortexActionability).
// Loaded via chrome.scripting.executeScript({ files: ['page-side/actionability.js'], world: 'MAIN' }).
//
// Reference: design doc §5.2 + docs/spec-l2-action.md §1, §5.
// 6 checks: Attached / Visible / Stable / ReceivesEvents / Enabled / Editable.
//
// Implementation constraints:
// - IIFE bundle：vite 打包时 inline 本地 page-side import（如 shadow-walk），运行时无外部依赖。
// - Defensive guard against double-load (page-side-loader is idempotent, but defend here too)
// - All checks are sync except Stable (which uses RAF double-sample)

import { queryDeep } from "./shadow-walk.js";

export type ActionabilityFailure =
  | "NOT_ATTACHED"
  | "NOT_VISIBLE"
  | "NOT_STABLE"
  | "OBSCURED"
  | "DISABLED"
  | "NOT_EDITABLE"
  // Tier 2 起不再由 probe 发射：findInOpenShadow 已让 open-shadow 元素可解析。保留作安全网——
  // 若未来出现不可解析的 shadow 路径，此非重试分支避免 TIMEOUT 空转。
  | "OPEN_SHADOW";

export type ActionabilityResult =
  | { ok: true; rect: { x: number; y: number; w: number; h: number } }
  | {
      ok: false;
      reason: ActionabilityFailure;
      extras?: { blocker?: string; tagName?: string; hasReadOnly?: boolean };
    };

(function () {
  if ((window as any).__vortexActionability?.version === 1) return;

  function isAttached(el: Element): boolean {
    return el.isConnected;
  }

  // observe 经 querySelectorAllDeep 穿 open shadow 发出 shadow-internal ref（buildSelector
  // 戳 data-vortex-rid）。light-DOM querySelector 看不到这些元素，故落空时用穿 shadow 的
  // queryDeep 兜底解析。closed shadow 仍不可达（CE spec）。
  function findInOpenShadow(selector: string): Element | null {
    try {
      return queryDeep(selector, document);
    } catch {
      return null;
    }
  }

  // Calibration #1: vortex decision — prefer checkVisibility(), do not check opacity, do not use offsetParent.
  // Use checkVisibility() when supported (Chromium/Firefox). Fall back to visibility style check for older WebKit.
  // Always require non-zero bounding rect.
  function isVisible(el: Element): boolean {
    if (typeof (el as any).checkVisibility === "function") {
      if (
        !(el as any).checkVisibility({
          checkOpacity: false, // vortex does not block on opacity
          checkVisibilityCSS: true,
          contentVisibilityAuto: true,
          opacityProperty: false,
          visibilityProperty: true,
        })
      ) {
        return false;
      }
    } else if (el instanceof HTMLElement) {
      // Fallback for browsers without checkVisibility() (e.g. older WebKit).
      const style = getComputedStyle(el);
      if (style.visibility !== "visible") return false;
    }
    // Always require non-zero rect
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return true;
  }

  function isEnabled(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;
    const aria = el.getAttribute("aria-disabled");
    if (aria === "true") return false;
    if ((el as HTMLInputElement).disabled === true) return false;
    const fs = el.closest("fieldset[disabled]");
    if (fs) return false;
    return true;
  }

  // Calibration #2: vortex decision — include SELECT readonly check.
  // contenteditable is always editable (readonly attribute is HTML-spec-invalid on contenteditable).
  function isEditable(
    el: Element,
  ): { ok: boolean; tagName: string; hasReadOnly: boolean } {
    if (!(el instanceof HTMLElement))
      return { ok: false, tagName: el.tagName.toLowerCase(), hasReadOnly: false };
    const tag = el.tagName.toLowerCase();
    // contenteditable is always editable (regardless of any "readonly" attribute,
    // which is HTML-spec-invalid on contenteditable)
    if (el.isContentEditable) return { ok: true, tagName: tag, hasReadOnly: false };
    // INPUT / TEXTAREA / SELECT — check readOnly state
    if (tag === "input" || tag === "textarea") {
      const ro = (el as HTMLInputElement | HTMLTextAreaElement).readOnly === true;
      return { ok: !ro, tagName: tag, hasReadOnly: ro };
    }
    if (tag === "select") {
      const ro = el.hasAttribute("readonly");
      return { ok: !ro, tagName: tag, hasReadOnly: ro };
    }
    // Anything else is not editable
    return { ok: false, tagName: tag, hasReadOnly: false };
  }

  function receivesEvents(
    el: Element,
    cx: number,
    cy: number,
  ): { ok: boolean; blocker?: string } {
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return { ok: false, blocker: "elementFromPoint=null" };
    if (hit === el || el.contains(hit) || hit.contains(el)) return { ok: true };
    // Backdrop compatibility: when an overlay (md-select dropdown / md-dialog /
    // CDK overlay / bootstrap modal) is open, its expected backdrop visually
    // covers the page area. elementFromPoint correctly returns the backdrop
    // because backdrops sit below the overlay pane in stacking context. But
    // the user-actioned target lives inside a higher-z overlay container and
    // is fully clickable. Without this carve-out, vortex couldn't fill the
    // search input or click md-option inside an md-select dropdown — the
    // root cause of the 2026-05-21 dogfood "Topic select 选不上" blocker.
    //
    // Heuristic: hit looks like a backdrop AND target sits inside a known
    // overlay container ancestry → not obscured.
    const hitTag = hit.tagName.toLowerCase();
    const hitClsLower =
      typeof hit.className === "string" ? hit.className.toLowerCase() : "";
    const isBackdrop =
      hitTag === "md-backdrop" ||
      hitClsLower.includes("cdk-overlay-backdrop") ||
      hitClsLower.includes("modal-backdrop") ||
      hitClsLower.includes("ant-modal-mask") ||
      hitClsLower.includes("backdrop");
    if (isBackdrop) {
      let cur: Element | null = el;
      while (cur && cur !== document.documentElement) {
        const t = cur.tagName.toLowerCase();
        const c =
          typeof cur.className === "string" ? cur.className.toLowerCase() : "";
        if (
          t === "md-select-menu" ||
          t === "md-dialog" ||
          t === "md-menu-content" ||
          c.includes("md-open-menu-container") ||
          c.includes("md-select-menu-container") ||
          c.includes("cdk-overlay-pane") ||
          c.includes("cdk-overlay-container") ||
          c.includes("ngdialog-content") ||
          c.includes("modal-content") ||
          c.includes("ant-modal-content") ||
          c.includes("el-dialog") ||
          c.includes("el-select-dropdown")
        ) {
          return { ok: true };
        }
        cur = cur.parentElement;
      }
    }
    const cls =
      typeof hit.className === "string" && hit.className
        ? "." + hit.className.split(" ").filter(Boolean).slice(0, 2).join(".")
        : "";
    const desc = hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + cls;
    return { ok: false, blocker: desc };
  }

  // Stable check: sample bounding rect across 1 RAF cycle, strict === comparison
  // (per L2-spec §7.2 "fixed 1 RAF cycle" + §1.3 "consecutive 2 RAF samples").
  // r1 captured synchronously, r2 after 1 rAF callback — the gap between the
  // two samples is exactly one animation frame. No tolerance: any sub-pixel
  // movement counts as not-stable (spec drops the original "< 1px" tolerance).
  function isStable(el: Element): Promise<boolean> {
    return new Promise((resolve) => {
      const r1 = el.getBoundingClientRect();
      requestAnimationFrame(() => {
        const r2 = el.getBoundingClientRect();
        const stable =
          r1.x === r2.x &&
          r1.y === r2.y &&
          r1.width === r2.width &&
          r1.height === r2.height;
        resolve(stable);
      });
    });
  }

  // Single-shot probe (no wait; host-side auto-wait orchestrates retries).
  // needsEditable: true for fill/type, false for click.
  // Stable is checked separately by host-side via probeStable (RAF cannot compose with chrome.scripting boundary).
  //
  // Check order: Attached → Visible → Enabled → Editable → ReceivesEvents.
  // Note this differs from L2-spec §1's catalog numbering (1.1-1.6), which is
  // an ID list not an execution order. Vortex deliberately checks Enabled/
  // Editable before ReceivesEvents because DISABLED / NOT_EDITABLE produce
  // more actionable hints for the LLM than OBSCURED — a disabled element
  // hidden behind a modal should report "wait for prereq to enable" first,
  // not "dismiss the overlay" (the modal might be the prereq itself).
  async function probe(
    selector: string,
    needsEditable: boolean,
  ): Promise<ActionabilityResult> {
    // querySelector throws SyntaxError on invalid CSS (e.g. raw v0.5-style
    // snapshot ref slipped past mcp ref-parser). Swallow it as not-attached
    // so the host wrapper sees a structured result instead of a nullish
    // chrome.scripting result triggering `null.ok` JS_EXECUTION_ERROR.
    let el: Element | null;
    try {
      // light-DOM 优先；落空时穿 open shadow 兜底（Tier 2：shadow-internal 元素现可操作）。
      el = document.querySelector(selector) ?? findInOpenShadow(selector);
    } catch {
      el = null;
    }
    if (!el) {
      // 真实未挂载 / 仅存在于 closed shadow → 可重试（transient）。
      return { ok: false, reason: "NOT_ATTACHED" };
    }
    if (!isAttached(el)) return { ok: false, reason: "NOT_ATTACHED" };
    if (!isVisible(el)) return { ok: false, reason: "NOT_VISIBLE" };
    if (!isEnabled(el)) return { ok: false, reason: "DISABLED" };
    if (needsEditable) {
      const ed = isEditable(el);
      if (!ed.ok) {
        return {
          ok: false,
          reason: "NOT_EDITABLE",
          extras: { tagName: ed.tagName, hasReadOnly: ed.hasReadOnly },
        };
      }
    }
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const re = receivesEvents(el, cx, cy);
    if (!re.ok) return { ok: false, reason: "OBSCURED", extras: { blocker: re.blocker } };
    return { ok: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }

  // Stable re-check: host-side calls this immediately after probe ok to confirm position is stable.
  async function probeStable(selector: string): Promise<{ ok: boolean }> {
    let el: Element | null;
    try {
      el = document.querySelector(selector) ?? findInOpenShadow(selector);
    } catch {
      el = null;
    }
    if (!el) return { ok: false };
    const stable = await isStable(el);
    return { ok: stable };
  }

  (window as any).__vortexActionability = {
    version: 1,
    probe,
    probeStable,
    // Atomic methods exposed for host-side direct use
    _isAttached: isAttached,
    _isVisible: isVisible,
    _isEnabled: isEnabled,
    _isEditable: isEditable,
    _receivesEvents: receivesEvents,
  };
})();

export {};
