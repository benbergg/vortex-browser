// 内容卡判据真源(纯逻辑,jsdom 可单测)。与 observe.ts 注入体(executeScript func
// 自包含、不能 import)内联的同名逻辑保持同语义——改一处须同步另一处。
import { hasFrameworkClickHandler } from "./framework-handlers.js";

/** el 内「可点子项」:cursor:pointer 或框架 onClick 的后代(不含 el 自身)。 */
function collectClickableDescendants(el: Element, cap = 200): Set<Element> {
  const set = new Set<Element>();
  const all = el.querySelectorAll("*");
  for (let i = 0; i < all.length && i < cap; i++) {
    const d = all[i];
    if (getComputedStyle(d as Element).cursor === "pointer" || hasFrameworkClickHandler(d)) {
      set.add(d);
    }
  }
  return set;
}

/**
 * el 是否有「不归属任何可点子项」的实质文本。
 * 内容卡(商品卡/评价卡)自身文本不在可点子里 → true;
 * 选项容器(SKU 区)文本全在可点子里 → false。
 */
export function hasOwnContentText(el: Element, threshold = 8): boolean {
  const clickable = collectClickableDescendants(el);
  const walker = el.ownerDocument!.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let own = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || "").trim();
    if (!text) continue;
    let inClickable = false;
    for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
      if (clickable.has(p)) { inClickable = true; break; }
    }
    if (!inClickable) {
      own += text.length;
      if (own >= threshold) return true;
    }
  }
  return own >= threshold;
}

/** 内容卡 = 自身有框架 onClick 且有自有内容文本。 */
export function isClickableContentCard(el: Element): boolean {
  return hasFrameworkClickHandler(el) && hasOwnContentText(el);
}

/** el 自身独立可点:cursor:pointer 或框架 onClick 挂在 el 自己身上。 */
export function isSelfClickable(el: Element): boolean {
  return getComputedStyle(el).cursor === "pointer" || hasFrameworkClickHandler(el);
}
