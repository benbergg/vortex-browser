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
