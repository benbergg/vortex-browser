// packages/extension/src/page-side/heal-resolve.ts
//
// descriptor 透明自愈的纯匹配器（可单测真源）。host 侧 action/heal.ts 的 executeScript
// 内联体复刻同一匹配语义（自包含、不能 import），heal-inline-alignment.test.ts 校验对齐。
//
// 设计：observe 存的 name 来自 getAccessibleName（aria-label / aria-labelledby / label /
// 可见文本 / icon 回退）。本匹配器覆盖**主流命名来源**：aria-label / aria-labelledby /
// label[for] / 包裹 label / 可见文本——与 observe getAccessibleName 的优先级顺序对齐。
// exotic icon-font 命名等边角情况匹配不上 → 上层降级 STALE_REF（优雅降级，符合产品标准）。
// 刻意排除：input placeholder/title、<input type=submit/button> 的 value-as-name 等 observe
// 兜底来源（YAGNI，命中不上则优雅降级 STALE_REF）。

/** 空白折叠 + trim。与 observe normName / descriptor.normalizeName 同语义。 */
export function normName(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 候选元素的 name 候选集，来源顺序对齐 observe getAccessibleName：
 * 1. aria-label
 * 2. aria-labelledby（空格分隔 IDREF，在元素所在 root 内解析）
 * 3. label[for="id"]（input/select/textarea 专用，使用 document 查询）
 * 4. 包裹 label（input/select/textarea 可用，radio/checkbox 尤其常见）
 * 5. 可见文本（textContent，通用兜底；select 故意跳过以避免 option 噪声）
 */
function elementNames(el: Element): string[] {
  const names: string[] = [];

  // 1. aria-label
  const ariaLabel = normName(el.getAttribute("aria-label"));
  if (ariaLabel) names.push(ariaLabel);

  // 2. aria-labelledby：空格分隔 IDREF 列表，在元素所在 root 内逐个解析
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      if (!id) continue;
      const ref =
        typeof (root as Document).getElementById === "function"
          ? (root as Document).getElementById(id)
          : document.getElementById(id);
      if (ref) parts.push(ref.textContent ?? "");
    }
    const lbName = normName(parts.join(" "));
    if (lbName) names.push(lbName);
  }

  // 3 & 4. label[for] / 包裹 label（仅 input/select/textarea）
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    // label[for="id"]：与 observe 一致使用 document.querySelector
    const id = el.id;
    if (id) {
      const lbl = document.querySelector(`label[for="${id}"]`);
      if (lbl) {
        const n = normName(lbl.textContent);
        if (n) names.push(n);
      }
    }
    // 包裹 label：el.closest("label") 在 light DOM 中向上找包裹的 label
    // 注：observe 仅对 radio/checkbox 用 closest，匹配器扩展到全 INPUT/SELECT/TEXTAREA（超集安全，name 精确匹配仍需通过，不引入误配）
    const wrapLabel = el.closest("label");
    if (wrapLabel) {
      const n = normName(wrapLabel.textContent);
      if (n) names.push(n);
    }
  }

  // 5. 可见文本（select 故意跳过：textContent = 全部 option 噪声）
  if (tag !== "SELECT") {
    const text = normName(el.textContent);
    if (text) names.push(text);
  }

  return names;
}

/** tag→role 高确定性映射，未知 tag 不否决（role 仅软过滤）。 */
const TAG_ROLE_MAP: Record<string, string> = {
  button: "button",
  a: "link",
  input: "textbox",
  select: "combobox",
  textarea: "textbox",
};

/** 元素是否匹配 role（软过滤）：仅用 tag→role 的高确定性映射，未知则不否决。 */
function roleMatches(el: Element, role: string): boolean {
  const tag = el.tagName.toLowerCase();
  const intrinsic = TAG_ROLE_MAP[tag];
  if (!intrinsic) return true; // 未知 tag 不否决（role 仅软过滤）
  return intrinsic === role;
}

export type MatchResult =
  | { kind: "unique"; el: Element }
  | { kind: "ambiguous" }
  | { kind: "none" };

/**
 * 在 candidates 中按 descriptor 找唯一命中。
 * 1) name 精确匹配（归一化后）筛候选；
 * 2) 命中 >1 且 desc.role 存在 → 用 role 软过滤再消歧；
 * 3) 唯一→unique；仍多→ambiguous；零→none。
 */
export function matchByDescriptor(
  candidates: Element[],
  desc: { role?: string; name: string },
): MatchResult {
  const target = normName(desc.name);
  if (!target) return { kind: "none" };

  let hits = candidates.filter((el) => elementNames(el).includes(target));
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1 && desc.role) {
    const narrowed = hits.filter((el) => roleMatches(el, desc.role!));
    if (narrowed.length >= 1) hits = narrowed;
  }
  if (hits.length === 1) return { kind: "unique", el: hits[0] };
  return { kind: "ambiguous" };
}
