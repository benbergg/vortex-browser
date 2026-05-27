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
