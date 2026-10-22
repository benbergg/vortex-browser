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

(function () {
  if ((window as any).__vortexHoverReveal?.version === 1) return;

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

  /** 浅查 + open shadow 下钻(与 dom-resolve 同口径的最小实现) */
  function queryDeep(selector: string): Element | null {
    try {
      const direct = document.querySelector(selector);
      if (direct) return direct;
    } catch {
      return null; // 非法选择器:当作未命中,不抛
    }
    const stack: Element[] = Array.from(document.querySelectorAll("*"));
    while (stack.length) {
      const el = stack.pop()!;
      const root = el.shadowRoot;
      if (!root) continue;
      try {
        const hit = root.querySelector(selector);
        if (hit) return hit;
      } catch {
        /* 非法选择器:跳过 */
      }
      stack.push(...Array.from(root.querySelectorAll("*")));
    }
    return null;
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
      target = queryDeep(selector);
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
          text: (cur.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
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
      target = queryDeep(selector);
    } catch {
      return false;
    }
    if (!target) return false;
    return isElementVisible(target);
  }

  (window as any).__vortexHoverReveal = {
    version: 1,
    collectCandidates,
    isVisible,
  };
})();
