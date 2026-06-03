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

// 元素 disabled 判定:aria-disabled + 原生 disabled + fieldset[disabled]。
// 单一真源,供 actionability 门(isEnabled)与 dom-resolve 探测(__vortexDomResolve.isEnabled)
// 共用——避免门/探测各持一份逻辑漂移(批次 5 族 H 的根:探测 vs 门语义不一致)。
export function isEnabledElement(el: Element): boolean {
  try {
    if (!(el instanceof HTMLElement)) return true;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if ((el as HTMLInputElement).disabled === true) return false;
    if (el.closest("fieldset[disabled]")) return false;
    return true;
  } catch {
    return true;
  }
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
