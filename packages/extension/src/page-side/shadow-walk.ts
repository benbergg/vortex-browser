// 穿 open shadow 的 DOM 查询。light-DOM 优先快路径；落空才递归 open shadow root。
// closed shadow（element.shadowRoot === null）不可见，符合 Custom Elements spec。
// 与 observe.ts 内联的 querySelectorAllDeep 同语义，此处抽为可复用 + 可单测的纯函数。

const MAX_SHADOW_DEPTH = 10;

export function queryDeep(
  selector: string,
  root: Document | ShadowRoot = document,
): Element | null {
  return queryDeepImpl(selector, root, 0);
}

function queryDeepImpl(
  selector: string,
  root: Document | ShadowRoot,
  depth: number,
): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  if (depth >= MAX_SHADOW_DEPTH) return null;
  for (const host of Array.from(root.querySelectorAll("*"))) {
    const sr = (host as HTMLElement).shadowRoot; // null for closed
    if (sr) {
      const found = queryDeepImpl(selector, sr, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function queryAllDeep(
  selector: string,
  root: Document | ShadowRoot = document,
): Element[] {
  return queryAllDeepImpl(selector, root, 0);
}

function queryAllDeepImpl(
  selector: string,
  root: Document | ShadowRoot,
  depth: number,
): Element[] {
  const acc: Element[] = Array.from(root.querySelectorAll(selector));
  if (depth >= MAX_SHADOW_DEPTH) return acc;
  for (const host of Array.from(root.querySelectorAll("*"))) {
    const sr = (host as HTMLElement).shadowRoot;
    if (sr) acc.push(...queryAllDeepImpl(selector, sr, depth + 1));
  }
  return acc;
}

// 元素 disabled 判定:aria-disabled + 原生 disabled + fieldset[disabled] + inert 子树。
// 单一真源,供 actionability 门(isEnabled)与 dom-resolve 探测(__vortexDomResolve.isEnabled)
// 共用——避免门/探测各持一份逻辑漂移(批次 5 族 H 的根:探测 vs 门语义不一致)。
export function isEnabledElement(el: Element): boolean {
  try {
    if (!(el instanceof HTMLElement)) return true;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if ((el as HTMLInputElement).disabled === true) return false;
    if (el.closest("fieldset[disabled]")) return false;
    // inert 子树:元素及后代不可聚焦/不可点(浏览器层禁用交互),但 checkVisibility
    // 默认不计 inert → act 点击静默无效。同 fieldset[disabled] 级联,判非交互让门/
    // 探测一致报 DISABLED 而非静默挂超时(2026-06-04 审计)。
    if (el.closest("[inert]")) return false;
    return true;
  } catch {
    return true;
  }
}

// 穿 shadow 边界的 contains（composed/flat 树包含判定）。Node.contains() 不跨 shadow，
// 故当 hit-test 命中 target 自身 shadow root 内的元素（如 sl-option / sl-menu-item 等
// web-component 叶子控件把 label 经 <slot> 渲染在自身 shadow 内）时，ancestor.contains(node)
// 恒 false → actionability 误判 OBSCURED。此函数从 node 沿 composed 树上溯（穿 shadow host）
// 逐级用 light-DOM contains 比对，覆盖「node 在 ancestor 自身或更深 shadow 子树内」的情形。
export function composedContains(ancestor: Element, node: Element | null): boolean {
  let n: Element | null = node;
  let depth = 0;
  while (n && depth < MAX_SHADOW_DEPTH) {
    if (n === ancestor || ancestor.contains(n)) return true;
    // getRootNode() 返回 Document 或 ShadowRoot；仅 ShadowRoot 有 .host（duck-type
    // 判别,避免引用可能未暴露的 ShadowRoot 全局,与代码库其余 shadow 处理一致）。
    const root = n.getRootNode() as { host?: Element };
    n = root && root.host ? root.host : null;
    depth++;
  }
  return false;
}

// document.elementFromPoint 对 shadow-internal 元素返回其 shadow host（composed 树顶,
// 重定向到 shadow 边界）。逐级下钻 open shadow root 的 elementFromPoint 得到真实命中元素,
// 使遮挡检查对 shadow 内元素成立（否则 host.contains(el) 不穿 shadow → 误判遮挡）。
export function deepElementFromPoint(cx: number, cy: number): Element | null {
  let el = document.elementFromPoint(cx, cy);
  let depth = 0;
  while (el && (el as HTMLElement).shadowRoot && depth < 10) {
    const inner = (el as HTMLElement).shadowRoot!.elementFromPoint(cx, cy);
    if (!inner || inner === el) break;
    el = inner;
    depth++;
  }
  return el;
}
