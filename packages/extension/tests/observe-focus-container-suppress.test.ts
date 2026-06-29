/**
 * Author: qingwa
 * Description: N0064 D6 列表设置 dogfood —— observe 漏抓 Element UI 弹层内自定义
 *   交互项的根因修复。
 *
 *   实机白盒锁定:Element UI 2.x el-popover / el-dialog / el-drawer 的浮层容器
 *   自带 `tabindex="0"`(可聚焦)+ `role="tooltip|dialog"`,因 `[tabindex]:not([-1])`
 *   命中 INTERACTIVE_SELECTORS 进入 interactiveSet。cursor:pointer fallback 的
 *   "跨池祖先短路"(observe.ts ancestor loop)原本对任何 interactiveSet 祖先都
 *   `continue`,于是 columnDisplay 内 9 个 bnCheck(cursor:pointer)因祖先 el-popover
 *   在池内被全部吞掉 → a11y 树只剩搜索框 + 确定按钮,9 列 checkbox 全丢(D2/D3/D5/D6/D8)。
 *
 *   真根因:短路把"仅因 tabindex 可聚焦的容器"误当"原子控件"。原子控件
 *   (button/a/[role=button|menuitem|option…]/label)确实独占其子树(避免 <button><span>
 *   双现),但聚焦/浮层容器不"描述"其子项——子项是独立控件,不该被吞。
 *
 *   isFocusContainerOnly 判据:祖先若 role ∈ 容器角色集 或 仅靠 tabindex 入池
 *   (非原子控件)→ 聚焦容器,短路不应触发。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { isFocusContainerOnly } from "../src/handlers/observe.js";

describe("isFocusContainerOnly (N0064 D6: tabindex 容器不吞 cursor:pointer 子项)", () => {
  let document: Document;
  beforeEach(() => {
    document = new JSDOM("<!DOCTYPE html><body></body>").window.document;
  });

  it("el-popover (role=tooltip + tabindex=0) 是聚焦容器 → 不抑制子项", () => {
    const pop = document.createElement("div");
    pop.className = "el-popover el-popper";
    pop.setAttribute("role", "tooltip");
    pop.setAttribute("tabindex", "0");
    document.body.appendChild(pop);
    expect(isFocusContainerOnly(pop)).toBe(true);
  });

  it("纯 tabindex 容器 (无 role) → 聚焦容器,不抑制", () => {
    const div = document.createElement("div");
    div.setAttribute("tabindex", "0");
    document.body.appendChild(div);
    expect(isFocusContainerOnly(div)).toBe(true);
  });

  it("el-dialog (role=dialog) → 容器,不抑制", () => {
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    expect(isFocusContainerOnly(dlg)).toBe(true);
  });

  it("真 <button> → 原子控件,抑制子项(非聚焦容器)", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    expect(isFocusContainerOnly(btn)).toBe(false);
  });

  it("[role=menuitem] + tabindex → 原子控件,抑制", () => {
    const mi = document.createElement("div");
    mi.setAttribute("role", "menuitem");
    mi.setAttribute("tabindex", "0");
    document.body.appendChild(mi);
    expect(isFocusContainerOnly(mi)).toBe(false);
  });

  it("[role=button] + tabindex → 原子控件,抑制(role 优先于 tabindex)", () => {
    const rb = document.createElement("div");
    rb.setAttribute("role", "button");
    rb.setAttribute("tabindex", "0");
    document.body.appendChild(rb);
    expect(isFocusContainerOnly(rb)).toBe(false);
  });

  it("<a href> → 原子控件,抑制", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "#");
    document.body.appendChild(a);
    expect(isFocusContainerOnly(a)).toBe(false);
  });
});

import { readFileSync } from "node:fs";
const OBSERVE_SRC = readFileSync(
  "/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts",
  "utf8",
);

describe("inject func 内联 isFocusContainerOnly + 跨池短路接入(源码锁,改一处须同步)", () => {
  it("inject func 含内联 isFocusContainerOnly 定义", () => {
    expect(OBSERVE_SRC).toMatch(/const isFocusContainerOnly = \(anc: Element\): boolean =>/);
  });
  it("内联含 FOCUS_CONTAINER_ROLES 与 ATOMIC_INTERACTIVE_SELECTORS", () => {
    expect((OBSERVE_SRC.match(/FOCUS_CONTAINER_ROLES/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((OBSERVE_SRC.match(/ATOMIC_INTERACTIVE_SELECTORS/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  it("跨池祖先短路用 interactiveSet.has(p) && !isFocusContainerOnly(p)", () => {
    expect(OBSERVE_SRC).toMatch(
      /interactiveSet\.has\(p\) && !isFocusContainerOnly\(p\)/,
    );
  });
});

/**
 * 注入体 FOCUS_CONTAINER_ROLES 必须派生自 aria-taxonomy.ts,不能是旧手维护硬编码。
 * 旧 17 项硬编码仅含 tooltip/dialog/alertdialog/group/region/menu/listbox/tree/grid/
 * table/tabpanel/navigation/toolbar/document/application/none/presentation,缺失大量真
 * 容器角色(article/list/listitem/menubar/radiogroup/tablist/treegrid/row/rowgroup/cell/
 * feed/figure/separator/note/term/definition/directory/caption/blockquote/form/main/
 * search/banner/complementary/contentinfo),jsdom 单测通过但生产 inject 仍按旧语义
 * 执行 → 双轨分裂。Task 2 CRITICAL 修复:同步 inject 内联副本与导出版派生一致。
 */
describe("inject func FOCUS_CONTAINER_ROLES 派生自 aria-taxonomy.ts(源码锁,防止硬编码回退)", () => {
  it("inject 内联副本含 DERIVED_FROM_ARIA_TAXONOMY marker", () => {
    expect(OBSERVE_SRC).toMatch(/DERIVED_FROM_ARIA_TAXONOMY/);
  });
  it("inject 内联副本用 Object.keys(...)filter(...) 派生表达式(非硬编码角色列表)", () => {
    // 真源派生形态:...Object.keys(ARIA_ROLE_TAXONOMY).filter(isContainerRole)
    // inject 内联副本形态(避免命名冲突):...Object.keys(__ARIA_ROLE_TAXONOMY).filter(__isContainerRole)
    expect(OBSERVE_SRC).toMatch(
      /Object\.keys\(__ARIA_ROLE_TAXONOMY\)\.filter\(__isContainerRole\)/,
    );
  });
  it("inject 内联副本内联 ARIA_ROLE_TAXONOMY 真源完整分类表", () => {
    // 真源定义的角色分类全部内联进来(composite/structure/landmark/window 四类容器)
    // 对象 key 用无引号简写:`button:["widget"]`
    const requiredRoles = [
      // composite
      "combobox", "menubar", "radiogroup", "tablist", "treegrid",
      // structure
      "article", "listitem", "feed", "figure", "separator", "note",
      "term", "definition", "directory", "caption", "blockquote",
      // landmark
      "banner", "complementary", "contentinfo", "form", "main", "search",
      // window
      "dialog", "alertdialog",
    ];
    for (const r of requiredRoles) {
      expect(OBSERVE_SRC).toContain(`${r}:[`);
    }
  });
  it("inject 内联副本派生覆盖旧硬编码全部 17 项 + 新增 26 项", () => {
    // 旧硬编码存在的项,inject 内联副本中也必须存在(防止改写时遗漏)
    const oldHardcoded = [
      "tooltip", "dialog", "alertdialog", "group", "region", "menu",
      "listbox", "tree", "grid", "table", "tabpanel", "navigation",
      "toolbar", "document", "application",
    ];
    for (const r of oldHardcoded) {
      expect(OBSERVE_SRC).toContain(`${r}:[`);
    }
    // 旧硬编码没有、但派生后必须含的代表性新角色(防止偷工减料回退到旧硬编码)
    const newDerived = ["menubar", "treegrid", "form", "main", "search", "feed"];
    for (const r of newDerived) {
      expect(OBSERVE_SRC).toContain(`${r}:[`);
    }
  });
  it("inject 内联副本 FOCUS_CONTAINER_ROLES = new Set 后跟 \"none\" + \"presentation\" 装饰", () => {
    // 派生表达式尾部追加的装饰占位(真源与内联副本必须一致)
    expect(OBSERVE_SRC).toMatch(
      /\.\.\.Object\.keys\(__ARIA_ROLE_TAXONOMY\)\.filter\(__isContainerRole\),\s*"none",\s*"presentation",\s*\]/,
    );
  });
  it("inject 内联副本的 isContainerRole 判据镜像真源(CATEGORY_PRIORITY + CONTAINER 四类)", () => {
    // 真源 isContainerRole:取主类(composite/window/landmark/structure 优先)∈ CONTAINER
    expect(OBSERVE_SRC).toContain('["composite","window","landmark","structure","live","range","widget"]');
    expect(OBSERVE_SRC).toContain('new Set(["composite","structure","landmark","window"])');
  });
});
