// @vitest-environment jsdom
/**
 * Description: N0002 B005 — treeitem 嵌套深度推断 fallback。
 *   Element Plus / antd Tree 等组件忘记在 DOM 上写 aria-level, 但 DOM 嵌套
 *   (tree → group → treeitem) 能反映层级深度。aria-level attribute 优先
 *   (作者显式声明), 此函数仅作 fallback。沿 [role=tree] 祖先上溯, 每穿过
 *   [role=group] 累加 1。tree 顶层 level=1, 嵌 1 个 group = 2, 嵌 2 = 3。
 *   无 [role=tree] 祖先 → undefined(非树形控件)。
 *   本测试用对象字面量 mock Element(getAttribute + closest + parentElement 链),
 *   不依赖 jsdom 渲染真实 DOM — 与 isModalLikeOverlay mock 风格一致。
 */
import { describe, it, expect } from "vitest";
import { inferTreeitemLevel } from "../src/handlers/observe.js";

/**
 * 构造一个 mock Element 链:treeitem → (group?) → (group?) → tree → 根。
 * attrs: treeitem 自身的属性;parents: 上溯角色链(从 treeitem 父到 tree 父,顺序),
 *        不含 treeitem 自身。例如 level=2 = [group, tree], level=3 = [group, group, tree]。
 */
function buildChain(
  treeitemAttrs: Record<string, string | null>,
  parents: Array<"group" | "tree" | "none">,
): Element {
  const treeitem: any = {
    getAttribute: (n: string) =>
      n in treeitemAttrs ? treeitemAttrs[n] ?? null : null,
  };
  let current: any = treeitem;
  for (const role of parents) {
    const parent: any = {
      getAttribute: (n: string) => (n === "role" ? role : null),
    };
    current.parentElement = parent;
    current = parent;
  }
  treeitem.closest = (sel: string) => {
    if (sel !== "[role=tree]") return null;
    // 沿 parentElement 链找 tree
    let n: any = treeitem;
    while (n) {
      if (n.getAttribute && n.getAttribute("role") === "tree") return n;
      n = n.parentElement;
    }
    return null;
  };
  return treeitem as Element;
}

describe("observe-treeitem-level: inferTreeitemLevel (N0002 B005)", () => {
  it("treeitem 直接在 tree 内(parents=[tree]) → level=1", () => {
    const e = buildChain({ role: "treeitem" }, ["tree"]);
    expect(inferTreeitemLevel(e)).toBe(1);
  });

  it("tree → group → treeitem(parents=[group, tree]) → level=2", () => {
    const e = buildChain({ role: "treeitem" }, ["group", "tree"]);
    expect(inferTreeitemLevel(e)).toBe(2);
  });

  it("tree → group → group → treeitem(parents=[group, group, tree]) → level=3", () => {
    const e = buildChain({ role: "treeitem" }, ["group", "group", "tree"]);
    expect(inferTreeitemLevel(e)).toBe(3);
  });

  it("树更深 4 层 → level=4", () => {
    const e = buildChain({ role: "treeitem" }, ["group", "group", "group", "tree"]);
    expect(inferTreeitemLevel(e)).toBe(4);
  });

  it("无 [role=tree] 祖先(parents=[none]) → undefined(非树形控件)", () => {
    const e = buildChain({ role: "treeitem" }, ["none"]);
    expect(inferTreeitemLevel(e)).toBeUndefined();
  });

  it("无 [role=tree] 祖先(完全孤立) → undefined", () => {
    const e = buildChain({ role: "treeitem" }, []);
    expect(inferTreeitemLevel(e)).toBeUndefined();
  });

  it("中间有非 group 元素(div 包裹)不算层级 — closest 跨过 div 找 tree", () => {
    // 链: treeitem → div(non-group) → group → tree
    const treeitem: any = {
      getAttribute: (n: string) => (n === "role" ? "treeitem" : null),
    };
    const div: any = { getAttribute: () => null };
    const group: any = { getAttribute: (n: string) => (n === "role" ? "group" : null) };
    const tree: any = { getAttribute: (n: string) => (n === "role" ? "tree" : null) };
    treeitem.parentElement = div;
    div.parentElement = group;
    group.parentElement = tree;
    treeitem.closest = (sel: string) => (sel === "[role=tree]" ? tree : null);
    // 算法: treeitem.parent=div (n !== tree, n.getAttribute('role')=null → 不 ++), n=group (role=group → ++, level=2), n=tree (==treeRoot 退出)
    expect(inferTreeitemLevel(treeitem as Element)).toBe(2);
  });

  it("aria-level 显式存在不影响 fallback(上层逻辑用 attribute 优先,此函数只算嵌套深度)", () => {
    const e = buildChain({ role: "treeitem", "aria-level": "5" }, ["group", "tree"]);
    // inferTreeitemLevel 算嵌套深度 = 2 (与 attribute 无关,attribute 优先在 getUiState 串联)
    expect(inferTreeitemLevel(e)).toBe(2);
  });
});
