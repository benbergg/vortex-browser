// packages/extension/src/page-side/hover-reveal.ts
//
// Hover 揭示辅助(page-side,MAIN world)。
//
// 背景:「父级 :hover 才显示」的控件(常见于工具条图标按钮)在 vortex 里两头落空——
// 扫描瞬间 display:none ⇒ observe 收不到;动作时 NOT_VISIBLE ⇒ act 空转到超时。
// 本模块提供两个原语,供 host 侧编排「先 hover 祖先把它揭示出来,再操作」:
//
//   collectCandidates(selector, maxDepth)
//       目标元素的「可见且有盒」祖先候选(由近及远)。父级 :hover 揭示成立时,
//       最近的那个可见祖先必然落在触发容器内 ⇒ hover 它即可触发容器的 :hover。
//   isVisible(selector)
//       目标当前是否可见(与 actionability 同口径:checkVisibility + 非零 rect)。
//
// 不引模块级 helper(page-side inline gotcha): 全部自包含,单例挂 window。
// （shadow-walk 是仓库内既有 page-side 模块，构建时 inline，与 actionability 同款做法。）

import { queryDeep } from "./shadow-walk.js";

(function () {
  if ((window as any).__vortexHoverReveal?.version === 1) return;

  /** hover 揭示的一对：触发元素（hover 它）+ 被揭示控件 */
  type RevealPair = {
    triggerSelector: string;
    triggerText: string;
    controlSelector: string;
    controlTag: string;
    controlClasses: string;
    controlName: string;
    controlCursor: string;
  };

  type RevealCandidate = {
    /** 距离目标的祖先层数(1 = 直接父级) */
    depth: number;
    /** 从 documentElement 起的子元素下标路径(供后续按路径重新定位) */
    path: number[];
    tag: string;
    id: string;
    cls: string;
    /** 可见文本摘要(供错误诊断与证据) */
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** 中心是否落在视口内(视口外的候选需先滚动) */
    inViewport: boolean;
  };

  /** 浅查 + open shadow 下钻（与 actionability 门同款查询，单一真源） */
  function queryTarget(selector: string): Element | null {
    try {
      return queryDeep(selector, document);
    } catch {
      return null; // 非法选择器:当作未命中,不抛
    }
  }

  /** 取计算样式:优先 window.getComputedStyle(测试环境无全局 getComputedStyle) */
  function computedStyle(el: Element): CSSStyleDeclaration | null {
    const fn = (window as any).getComputedStyle;
    if (typeof fn !== "function") return null;
    try {
      return fn.call(window, el);
    } catch {
      return null;
    }
  }

  /** 元素是否可见:与 actionability 的 isVisible 同口径 */
  function isElementVisible(el: Element): boolean {
    if (typeof (el as any).checkVisibility === "function") {
      if (
        !(el as any).checkVisibility({
          checkOpacity: false,
          checkVisibilityCSS: true,
          contentVisibilityAuto: true,
          opacityProperty: false,
          visibilityProperty: true,
        })
      ) {
        return false;
      }
    } else if (el instanceof HTMLElement) {
      const style = computedStyle(el);
      if (style?.visibility !== "visible") return false;
      if (style?.display === "none") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 从 documentElement 起到 el 的子元素下标路径 */
  function pathOf(el: Element): number[] {
    const path: number[] = [];
    let cur: Element | null = el;
    while (cur && cur.parentElement) {
      const parent: Element = cur.parentElement;
      const idx = Array.prototype.indexOf.call(parent.children, cur);
      path.unshift(idx);
      cur = parent;
    }
    return path;
  }

  /** 父级(穿 open shadow host) */
  function parentOf(el: Element): Element | null {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    const host = (root as ShadowRoot)?.host;
    return host ?? null;
  }

  function collectCandidates(selector: string, maxDepth: number): RevealCandidate[] {
    const out: RevealCandidate[] = [];
    let target: Element | null;
    try {
      target = queryTarget(selector);
    } catch {
      return out;
    }
    if (!target) return out;
    const limit = Math.max(1, Math.min(12, maxDepth || 6));
    let cur = parentOf(target);
    let depth = 1;
    while (cur && depth <= limit) {
      const style = cur instanceof HTMLElement ? computedStyle(cur) : null;
      const styleHidden = style?.display === "none" || style?.visibility === "hidden";
      const r = cur.getBoundingClientRect();
      if (!styleHidden && r.width > 0 && r.height > 0) {
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        out.push({
          depth,
          path: pathOf(cur),
          tag: cur.tagName.toLowerCase(),
          id: cur.id ?? "",
          cls: typeof cur.className === "string" ? cur.className : "",
          text: visibleText(cur, 60),
          x: cx,
          y: cy,
          w: r.width,
          h: r.height,
          inViewport: cx >= 0 && cy >= 0 && cx <= vw && cy <= vh,
        });
      }
      cur = parentOf(cur);
      depth++;
    }
    return out;
  }

  function isVisible(selector: string): boolean {
    let target: Element | null;
    try {
      target = queryTarget(selector);
    } catch {
      return false;
    }
    if (!target) return false;
    return isElementVisible(target);
  }

  /** 按子元素下标路径定位元素(与 pathOf 互逆) */
  function elementAtPath(path: number[]): Element | null {
    let cur: Element | null = document.documentElement;
    for (const idx of path ?? []) {
      if (!cur) return null;
      const child: Element | undefined = cur.children?.[idx];
      if (!child) return null;
      cur = child;
    }
    return cur;
  }

  /**
   * 重新测量某个祖先候选的当前中心点。
   * 候选坐标会陈旧：上一次 hover 可能引起重排/滚动，采集时的坐标不再对应原元素。
   * 每次派发鼠标前重测一次，元素消失或已不可见则返回 null（调用方跳过该候选）。
   */
  function measureCandidate(path: number[]): { x: number; y: number; w: number; h: number; inViewport: boolean } | null {
    const el = elementAtPath(path);
    if (!el) return null;
    const style = computedStyle(el);
    if (style && (style.display === "none" || style.visibility === "hidden")) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return {
      x: cx,
      y: cy,
      w: r.width,
      h: r.height,
      // 中心必须真的落在视口内：与视口“相交”的大元素中心可能在视口外
      inViewport: cx >= 0 && cy >= 0 && cx <= vw && cy <= vh,
    };
  }

  /** 把路径指向的元素滚进视口(目标自身隐藏时用其可见祖先滚) */
  function scrollIntoView(path: number[]): boolean {
    const el = elementAtPath(path);
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
      return true;
    } catch {
      return false;
    }
  }

  /** 等一帧:真鼠标移动后浏览器要更新 hover 态并重算样式,同帧内读可见性可能读到旧值 */
  function afterPaint(): Promise<void> {
    return new Promise((resolve) => {
      const w = window as any;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // 后台标签页 rAF 可能不触发:给 60ms 兜底,避免探针永挂
      const timer = setTimeout(finish, 60);
      if (typeof w.requestAnimationFrame === "function") {
        w.requestAnimationFrame(() => {
          clearTimeout(timer);
          finish();
        });
      } else {
        clearTimeout(timer);
        finish();
      }
    });
  }

  /** 状态型伪类：hover 揭示的规则里它们只在“当前状态成立”时才有意义 */
  const STATE_PSEUDO = /:(hover|focus|focus-within|focus-visible|active|visited|target)\b/g;

  /** 把选择器拆成复合器（按空白切，括号/方括号内不切） */
  function splitCompounds(sel: string): string[] {
    const out: string[] = [];
    let cur = "";
    let depth = 0;
    for (const ch of sel) {
      if (ch === "(" || ch === "[") depth++;
      if (ch === ")" || ch === "]") depth--;
      if (/\s/.test(ch) && depth === 0) {
        if (cur) out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** 按顶层逗号切选择器组（括号内不切） */
  function splitSelectorList(sel: string): string[] {
    const out: string[] = [];
    let cur = "";
    let depth = 0;
    for (const ch of sel) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  }

  /** 去掉状态型伪类与伪元素，得到“可静态匹配”的选择器片段 */
  function staticize(part: string): string {
    return part
      .replace(STATE_PSEUDO, "")
      .replace(/::[a-z-]+(\([^)]*\))?/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** 取元素的可见文本（跳过 display:none / visibility:hidden 子树） */
  function visibleText(el: Element, limit: number): string {
    const parts: string[] = [];
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const t = (child.textContent ?? "").replace(/\s+/g, " ").trim();
          if (t) parts.push(t);
        } else if (child.nodeType === 1) {
          const e = child as Element;
          const cs = computedStyle(e);
          if (cs && (cs.display === "none" || cs.visibility === "hidden")) continue;
          walk(e);
        }
      }
    };
    walk(el);
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  /**
   * 扫同源样式表里的 :hover 规则，找出「当前被隐藏、hover 某祖先即显现」的控件。
   * 只读：不动鼠标、不改页面。给 agent 一条「hover 谁 → 出现什么」的路标。
   */
  function findRevealPairs(maxPairs: number): RevealPair[] {
    const out: RevealPair[] = [];
    const limit = Math.max(1, Math.min(20, maxPairs || 8));
    // 规则遍历上界：超大字表（动辄上万条）不能让 observe 卡住。
    // 遍历本身只做子串判定（便宜），真正贵的是「显现型 :hover 规则」的选择器查询，
    // 那部分单独限流——否则被总量截断时，后面的 :hover 规则会整片漏掉。
    const MAX_RULES = 20_000;
    const MAX_REVEAL_RULES = 500;
    let scanned = 0;
    let revealScanned = 0;
    let sheets: CSSStyleSheet[] = [];
    try {
      sheets = Array.from(document.styleSheets);
    } catch {
      return out;
    }
    for (const sheet of sheets) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨源样式表：读不到就跳过
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (scanned++ > MAX_RULES) return out;
        const styleRule = rule as CSSStyleRule;
        const selectorText = styleRule.selectorText;
        const style = styleRule.style;
        if (!selectorText || !style || selectorText.indexOf(":hover") < 0) continue;
        // 只认“显现型”声明：display 非 none / visibility: visible / opacity > 0
        const display = style.display;
        const visibility = style.visibility;
        const opacity = style.opacity;
        const isReveal =
          (!!display && display !== "none") ||
          visibility === "visible" ||
          (!!opacity && parseFloat(opacity) > 0);
        if (!isReveal) continue;
        // 限流只算“显现型 :hover 规则”（它们才触发选择器查询）：普通 :hover 规则
        // （如 :hover 改背景色）不计入，否则会把后段的显现型规则整片挤掉。
        if (revealScanned++ > MAX_REVEAL_RULES) return out;

        for (const one of splitSelectorList(selectorText)) {
          if (out.length >= limit) return out;
          const compounds = splitCompounds(one);
          const hi = compounds.findIndex((c) => c.indexOf(":hover") >= 0);
          // 必须在 :hover 之后还有一段（被揭示的那一段）
          if (hi < 0 || hi + 1 >= compounds.length) continue;
          const triggerSel = staticize(compounds.slice(0, hi + 1).join(" "));
          // 前导组合符（"> i"）对 querySelectorAll 无效：去掉组合符，按后代关系取
          const controlRel = staticize(compounds.slice(hi + 1).join(" ")).replace(/^[>+~]\s*/, "");
          if (!triggerSel || !controlRel) continue;

          let triggers: Element[] = [];
          try {
            triggers = Array.from(document.querySelectorAll(triggerSel)).slice(0, 3);
          } catch {
            continue;
          }
          for (const trigger of triggers) {
            let controls: Element[] = [];
            try {
              controls = Array.from(trigger.querySelectorAll(controlRel)).slice(0, 3);
            } catch {
              continue;
            }
            for (const control of controls) {
              if (out.length >= limit) return out;
              // 只报“当前不可见”的：可见的 agent 已经能看到
              if (isElementVisible(control)) continue;
              const cs = computedStyle(control);
              const cursor = cs?.cursor ?? "";
              const title =
                control.getAttribute("title") ??
                control.getAttribute("aria-label") ??
                "";
              // 只报可交互控件：图标按钮/链接/带名元素。纯装饰元素对 agent 无用
              const interactive =
                cursor === "pointer" ||
                /^(button|a|input|select|textarea)$/i.test(control.tagName) ||
                !!title;
              if (!interactive) continue;
              out.push({
                triggerSelector: triggerSel.slice(0, 160),
                triggerText: visibleText(trigger, 40),
                controlSelector: buildControlSelector(control, triggerSel, controlRel),
                controlTag: control.tagName.toLowerCase(),
                controlClasses:
                  typeof control.className === "string" ? control.className.slice(0, 120) : "",
                controlName: title.slice(0, 60),
                controlCursor: cursor,
              });
            }
          }
        }
      }
    }
    return out;
  }

  /** 给 agent 一个能直接用的控件选择器：优先 id，其次唯一匹配，最后 trigger+control */
  function buildControlSelector(control: Element, triggerSel: string, controlRel: string): string {
    if (control.id) return `#${control.id}`;
    try {
      if (document.querySelectorAll(controlRel).length === 1) return controlRel.slice(0, 160);
    } catch {
      /* 忽略：走组合形式 */
    }
    return `${triggerSel} ${controlRel}`.slice(0, 200);
  }

  (window as any).__vortexHoverReveal = {
    version: 1,
    collectCandidates,
    measureCandidate,
    isVisible,
    scrollIntoView,
    afterPaint,
    findRevealPairs,
  };
})();
