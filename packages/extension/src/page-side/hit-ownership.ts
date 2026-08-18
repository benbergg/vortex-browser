// 命中归属判定的单一真源。此前 actionability 门 / dom.ts 合成路径 / cdp.ts realMouse
// 路径各存一份逐字拷贝的 contains 判据,「命中祖先无条件放行」这一路三处同时漏。
// 不引用全局 document:祖先遍历一律走 el.ownerDocument。

export type HitOwnership =
  | { ok: true }
  | { ok: false; blocker: string; kind: "overlay" | "ancestor" };

export function describeElement(el: Element): string {
  const cls =
    typeof el.className === "string" && el.className
      ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".")
      : "";
  return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
}

// 宽松判据:任意 role / tabindex / 原生交互标签。**逐字保留自原 isInteractiveEl**,
// 只服务于装饰层 carve-out(el-select),不参与祖先放行——那里用严格白名单。
export function isWidgetContainer(el: Element): boolean {
  const t = el.tagName.toLowerCase();
  return (
    !!el.getAttribute("role") ||
    el.getAttribute("tabindex") != null ||
    t === "button" ||
    t === "a" ||
    t === "input" ||
    t === "select" ||
    t === "textarea"
  );
}

// 严格白名单:哪些祖先「被点到」等价于目标被点到。
// 宽松版(任意 role)会放行 role="group" 的 swiper 轨道、role="presentation" 的纯装饰容器、
// tabindex="-1" 的 programmatic-focus 容器——正是本次要拦的那一类。
// 不含 gridcell / row / region / group:它们是**容器**语义,可点性来自内部控件而非自身,
// 放行会把「点在单元格空白处」当成点中了里面的按钮。有实测反例再加。
const CLICKABLE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "option", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton",
  "treeitem",
]);

export function isClickTargetAncestor(el: Element, hit: Element): boolean {
  const t = hit.tagName.toLowerCase();
  // label:点它把激活转发给**关联控件**。目标不是那个控件时不算到达
  // ——<label><div id=target></label> 点 label 不会激活 div(codex 二轮 P2-1)。
  if (t === "label") return (hit as HTMLLabelElement).control === el;
  if (t === "button" || t === "select" || t === "textarea" || t === "input" || t === "summary") return true;
  if (t === "a" || t === "area") return hit.hasAttribute("href");
  const role = (hit.getAttribute("role") ?? "").toLowerCase();
  if (role) return CLICKABLE_ROLES.has(role); // presentation / none / group / region → false
  const ti = hit.getAttribute("tabindex");
  return ti != null && Number(ti) >= 0; // tabindex="-1" 不算可点
}

// contains 不穿 shadow:shadow 内的目标对其 light-DOM host 祖先 contains 恒 false。
// 命中归属要按 composed 树算,否则 shadow 组件全部落到 overlay 分支、话术指错方向。
// 沿 composed 树取上一级:元素走 parentElement,shadow 根跨到 host。
export function composedParent(node: Element): Element | null {
  const p = node.parentNode as Node | null;
  if (p && (p as Element).nodeType === 1) return p as Element;
  if (p && (p as Node).nodeType === 11) return ((p as any).host as Element | undefined) ?? null; // ShadowRoot
  return null;
}

export function composedContains(ancestor: Element, node: Element): boolean {
  let cur: Element | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = composedParent(cur);
  }
  return false;
}

// 复合输入控件(el-select 等)把可见显示层作为兄弟节点叠在透明真控件之上,点击经显示层
// 冒泡仍到达同一 widget。hit 非交互且与目标同处一个交互容器 → 装饰层,不算遮挡。
// 祖先遍历与包含判断都走 composed 树:否则 shadow 内的 widget 装饰层在这里失效,
// 而 classifyHit 的祖先分支却穿了 shadow,三条路径判定不一致(codex 二轮 P2-3)。
function isSameWidgetDecoration(el: Element, hit: Element): boolean {
  // 只认兄弟装饰层:hit 是目标祖先时任何 role/tabindex 外壳都会误放行
  if (composedContains(hit, el)) return false;
  if (isWidgetContainer(hit)) return false;
  const root = el.ownerDocument.documentElement;
  let w: Element | null = composedParent(el);
  while (w && w !== root) {
    if (isWidgetContainer(w)) return composedContains(w, hit);
    w = composedParent(w);
  }
  return false;
}

// overlay 打开时其 backdrop 视觉覆盖页面,hit-test 命中 backdrop,但目标在更高 z 的
// overlay 容器内、完全可点。
function isBackdropCarveOut(el: Element, hit: Element): boolean {
  const hitTag = hit.tagName.toLowerCase();
  const hitCls = typeof hit.className === "string" ? hit.className.toLowerCase() : "";
  const isBackdrop =
    hitTag === "md-backdrop" ||
    hitCls.includes("cdk-overlay-backdrop") ||
    hitCls.includes("modal-backdrop") ||
    hitCls.includes("ant-modal-mask") ||
    hitCls.includes("backdrop");
  if (!isBackdrop) return false;
  const root = el.ownerDocument.documentElement;
  let cur: Element | null = el;
  // 同样走 composed 上溯:shadow 内的 md-dialog / el-select-dropdown 否则找不到。
  while (cur && cur !== root) {
    const t = cur.tagName.toLowerCase();
    const c = typeof cur.className === "string" ? cur.className.toLowerCase() : "";
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
      return true;
    }
    cur = composedParent(cur);
  }
  return false;
}

export function classifyHit(el: Element, hit: Element | null): HitOwnership {
  // 中心点没命中任何元素(被裁到视口外等)。保留原字符串:auto-wait 对它有专门话术分流。
  if (!hit) return { ok: false, blocker: "elementFromPoint=null", kind: "overlay" };
  if (hit === el || composedContains(el, hit)) return { ok: true };
  if (isSameWidgetDecoration(el, hit)) return { ok: true };
  if (isBackdropCarveOut(el, hit)) return { ok: true };
  if (composedContains(hit, el)) {
    // 白名单内的可点祖先维持放行:点击落在它身上语义等价
    // (button 内 pointer-events:none 的 span、label 包关联控件)。
    if (isClickTargetAncestor(el, hit)) return { ok: true };
    // 其余祖先 = 裁剪 / pointer-events:none / 祖先层覆盖,坐标派发到不了目标。
    return { ok: false, blocker: describeElement(hit), kind: "ancestor" };
  }
  return { ok: false, blocker: describeElement(hit), kind: "overlay" };
}
