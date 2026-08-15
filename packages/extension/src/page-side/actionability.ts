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

import { queryDeep, deepElementFromPoint, isEnabledElement } from "./shadow-walk.js";
import { classifyHit } from "./hit-ownership.js";

export type ActionabilityFailure =
  | "NOT_ATTACHED"
  | "NOT_VISIBLE"
  | "NOT_STABLE"
  | "OBSCURED"
  | "DISABLED"
  | "NOT_EDITABLE"
  // Tier 2 起不再由 probe 发射：findInOpenShadow 已让 open-shadow 元素可解析。保留作安全网——
  // 若未来出现不可解析的 shadow 路径，此非重试分支避免 TIMEOUT 空转。
  | "OPEN_SHADOW"
  // selector 不是合法 CSS（querySelector 抛 SyntaxError）。与 NOT_ATTACHED 分开——
  // 语法错误重试到天荒地老也不会变合法，必须立即失败并告知正确语法。
  | "INVALID_SELECTOR";

export type ActionabilityResult =
  | { ok: true; rect: { x: number; y: number; w: number; h: number } }
  | {
      ok: false;
      reason: ActionabilityFailure;
      extras?: { blocker?: string; tagName?: string; hasReadOnly?: boolean; inert?: boolean; ariaValueWidget?: string; hitKind?: "overlay" | "ancestor"; modalBlocked?: boolean };
    };

(function () {
  if ((window as any).__vortexActionability?.version === 2) return;

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

  // content-visibility:auto 处于 skip 态(离屏)的元素被 checkVisibility 计为不可见,
  // 但元素一旦滚进视口就渲染、完全可交互。判别式:contentVisibilityAuto:true 时不可见
  // 而 contentVisibilityAuto:false 时可见 ⇒ 仅因 cv-auto skip(display:none 等真隐藏两
  // 变体皆 false,不命中)。滚进视口 un-skip,使后续 visible/stable/occlusion 检查作用于
  // 已渲染元素;否则死锁 NOT_VISIBLE(或空 rect 中心 hit-test→OBSCURED)。2026-06-01 R2。
  function unskipIfContentVisibilityAuto(el: Element): void {
    const cv = el as unknown as {
      checkVisibility?: (opts: Record<string, boolean>) => boolean;
      scrollIntoView?: (opts: ScrollIntoViewOptions) => void;
    };
    if (typeof cv.checkVisibility !== "function") return;
    const base = {
      checkOpacity: false,
      opacityProperty: false,
      visibilityProperty: true,
      checkVisibilityCSS: true,
    };
    const skipped =
      cv.checkVisibility({ ...base, contentVisibilityAuto: true }) === false &&
      cv.checkVisibility({ ...base, contentVisibilityAuto: false }) === true;
    if (skipped && typeof cv.scrollIntoView === "function") {
      cv.scrollIntoView({ block: "center", inline: "center" });
    }
  }

  // 门的 disabled 判定与 dom-resolve 探测共用 shadow-walk.isEnabledElement(单一真源,
  // 防探测/门漂移——批次 5 族 H)。
  function isEnabled(el: Element): boolean {
    return isEnabledElement(el);
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
  ): { ok: boolean; blocker?: string; kind?: "overlay" | "ancestor" } {
    // 判据收敛到 hit-ownership.classifyHit(单一真源,dom.ts / cdp.ts 同款)。
    const own = classifyHit(el, deepElementFromPoint(cx, cy));
    return own.ok ? { ok: true } : { ok: false, blocker: own.blocker, kind: own.kind };
  }

  // Stable check: sample bounding rect across 1 RAF cycle, 0.5px sub-pixel
  // tolerance (per L2-spec §7.2 "stable 1 RAF cycle with 0.5px tolerance" +
  // §1.3 "consecutive 2 RAF samples" unchanged). r1 captured synchronously,
  // r2 after 1 rAF callback — the gap between the two samples is exactly
  // one animation frame. 0.5px tolerance accommodates sub-pixel reflow noise
  // inherent to modern SPAs (lazy-load, sticky header, animation, theme
  // transitions) and aligns with Playwright's actionability check.
  //
  // 缺陷③ (2026-06-07 v4 淘宝评测): 原 spec (v0.4.x) 砍掉了 <1px 容差, 改
  // 严格 ===, 在淘宝买家页子像素 reflow 场景 (cart 数字 87→88、猜你喜欢
  // lazy-load) 下所有 click 永远 NOT_STABLE, 唯一出口 options={force:true,
  // timeout:10000} 破坏"无需人工调优"承诺。L2-spec 决策 A (2026-06-07 KB):
  // 恢复 0.5px 容差, 与 Playwright 对齐, 修正 spec 漂移。
  function isStable(el: Element): Promise<boolean> {
    return new Promise((resolve) => {
      // 后台(hidden)标签 Chrome 暂停/节流 requestAnimationFrame → 下方 rAF 采样
      // 会卡到 host 探测超时(2026-06-09 京东搜索 fill/click 后台慢 ~2s 的真因;
      // 实测后台单次 rAF 5000ms 内从未回调、前台 8ms)。hidden 标签无可见动画、
      // 稳定性检查无意义,跳过 rAF 直接视作稳定 —— 实际交互仍走 CDP/合成路径,
      // 持续不稳由 force 兜底。
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        resolve(true);
        return;
      }
      const r1 = el.getBoundingClientRect();
      requestAnimationFrame(() => {
        const r2 = el.getBoundingClientRect();
        const TOL = 0.5; // px, L2-spec §7.2
        const stable =
          Math.abs(r1.x - r2.x) <= TOL &&
          Math.abs(r1.y - r2.y) <= TOL &&
          Math.abs(r1.width - r2.width) <= TOL &&
          Math.abs(r1.height - r2.height) <= TOL;
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
    force = false,
  ): Promise<ActionabilityResult> {
    // querySelector 对非法 CSS 抛 SyntaxError。此前一律 catch 成 el=null → NOT_ATTACHED
    // (可重试)，让 Playwright 语法(`text=` / `>>` / `:has-text()`)与自然语言 target 空转满
    // timeout 预算，最后抛出方向完全相反的 "Element detached from DOM" 诊断
    // (2026-07-29 iPaaS 实战：加大 timeout / wait idle 全部无效)。语法错不会因重试变合法，
    // 单列为不可重试的 INVALID_SELECTOR，由 host 侧 auto-wait 给出正确语法。
    let el: Element | null;
    try {
      // light-DOM 优先；落空时穿 open shadow 兜底（Tier 2：shadow-internal 元素现可操作）。
      el = document.querySelector(selector) ?? findInOpenShadow(selector);
    } catch (err) {
      // 主判据是 `.name`：DOM spec 规定 querySelector 抛的是 **DOMException**（name
      // 为 "SyntaxError"），`instanceof SyntaxError` 恒 false（实测已确认）。保留
      // instanceof 仅作跨引擎防御，不要以为它才是生效的那半。
      if ((err as { name?: string })?.name === "SyntaxError" || err instanceof SyntaxError) {
        return { ok: false, reason: "INVALID_SELECTOR" };
      }
      el = null;
    }
    if (!el) {
      // 真实未挂载 / 仅存在于 closed shadow → 可重试（transient）。
      return { ok: false, reason: "NOT_ATTACHED" };
    }
    if (!isAttached(el)) return { ok: false, reason: "NOT_ATTACHED" };
    unskipIfContentVisibilityAuto(el); // cv-auto skip 死锁防护(R2):先滚动 un-skip
    // force:true → 跳过质量门(visible/enabled/editable/obscured),仍要求 attached(上面已查)、
    // 仍 scrollIntoView + 取 rect 供 CDP/合成派发用。对齐 Playwright force 语义,让公开 schema
    // options.force 诚实(2026-06-04 H 族补实现:此前 force 是 no-op)。
    if (!force) {
      if (!isVisible(el)) return { ok: false, reason: "NOT_VISIBLE" };
      if (!isEnabled(el)) {
        // 区分 DISABLED 成因:inert 子树(常见于 modal/overlay 把背景内容设为 inert,
        // 加载即弹窗的真实站极普遍——Booking.com dogfood 2026-06-17)vs 原生 disabled。
        // 二者修复动作不同:inert 需关闭遮挡层,原生 disabled 需满足前置条件。
        // 携带 extras.inert 供 host 侧 waitActionable 生成可 actionable 的诊断。
        const inert = el instanceof HTMLElement && !!el.closest("[inert]");
        return { ok: false, reason: "DISABLED", extras: { inert } };
      }
      if (needsEditable) {
        const ed = isEditable(el);
        if (!ed.ok) {
          // ARIA value 控件(role=slider/spinbutton,div-based 如 Radix/APG)无可填 input,
          // 但可经键盘(Arrow/Home/End)或 drag 设值。携带 ariaValueWidget 供 host 侧生成
          // 可 actionable 指引,替代通用 hint 误导的「pick a selector pointing to an actual
          // input」——这类控件根本无 input(radix-ui slider dogfood 2026-06-22 实测,
          // 键盘 ArrowRight 50→51、vortex_mouse_drag 50→80 均生效)。
          const role = el.getAttribute("role");
          const ariaValueWidget =
            role === "slider" || role === "spinbutton" ? role : undefined;
          return {
            ok: false,
            reason: "NOT_EDITABLE",
            extras: { tagName: ed.tagName, hasReadOnly: ed.hasReadOnly, ariaValueWidget },
          };
        }
      }
    }
    let r = el.getBoundingClientRect();
    let cx = r.x + r.width / 2;
    let cy = r.y + r.height / 2;
    // 视口外死锁防护:元素在视口外(折叠线下/右等)时中心点落在视口外,
    // deepElementFromPoint 返回 null → receivesEvents 报 elementFromPoint=null →
    // OBSCURED → 重试到预算耗尽抛 TIMEOUT,却**从不滚动**(已渲染只是离屏,
    // 非 content-visibility skip,unskipIfContentVisibilityAuto 不命中)。复用其
    // 滚动模式:中心点出视口则 scrollIntoView({block:center}) 把元素带进视口、
    // 重算 rect/中心点,使后续 occlusion hit-test 作用于可点中的元素。
    // (2026-06-04 多 agent 审计 P1-1 LIVE 确认)
    const centerOffscreen =
      cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight;
    if (centerOffscreen && typeof (el as any).scrollIntoView === "function") {
      (el as Element).scrollIntoView({ block: "center", inline: "center" });
      r = el.getBoundingClientRect();
      cx = r.x + r.width / 2;
      cy = r.y + r.height / 2;
    }
    // 已聚焦的可编辑元素豁免 occlusion:F2/双击打开的单元格编辑器 textarea、IME 捕获框
    // 常是 1px 绝对定位并被 canvas 视觉遮挡 → deepElementFromPoint 命中上层 canvas →
    // 误判 OBSCURED 抛 TIMEOUT。但它已是编辑焦点(document.activeElement),CDP insertText/
    // 键入直达,视觉遮挡不影响事件送达。仅对 **编辑类动作**(needsEditable:true,即 type/fill;
    // dom.ts:639/919)放行,且限 activeElement + editable —— click/hover(needsEditable:false)
    // 的 occlusion 行为完全不变,blast radius 收到最小。
    // (钉钉 spreadsheetv2 等 canvas 电子表格 dogfood 2026-07,此前须手传 options.force)。
    const focusedEditable =
      needsEditable && el === document.activeElement && isEditable(el).ok;
    if (!force && !focusedEditable) {
      const re = receivesEvents(el, cx, cy);
      if (!re.ok) {
        // 原生 <dialog>.showModal() 打开时,浏览器把对话框外内容**隐式 inert**(不设
        // [inert] 属性)且其 ::backdrop 归属 dialog 元素 → hit-test 命中 dialog → OBSCURED。
        // R6 的 [inert] 检测(closest("[inert]"))对原生 modal dialog 失效(无属性),
        // 且 reason 是 OBSCURED 非 DISABLED。携 modalBlocked 供 host 侧 waitActionable
        // 生成「关闭 modal」可 actionable 诊断,完成 R6 另一半覆盖(原生 <dialog> 是当今
        // 标准 modal)。判据 `dialog:modal` 经 example.com live spike 实证(2026-06-17)。
        let modalBlocked = false;
        try {
          modalBlocked =
            el instanceof Element &&
            typeof el.closest === "function" &&
            !!document.querySelector("dialog:modal") &&
            !el.closest("dialog:modal");
        } catch {
          modalBlocked = false; // :modal 伪类不被支持的旧引擎 → 静默降级
        }
        return { ok: false, reason: "OBSCURED", extras: { blocker: re.blocker, hitKind: re.kind, modalBlocked } };
      }
    }
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
    version: 2,
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
