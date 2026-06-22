/**
 * Author: qingwa
 * Description: FullCalendar `<a.fc-event>` dogfood —— observe 把单一复合控件误判为多 CTA
 *   容器、拆成多个碎片 ref 的根因修复。
 *
 *   实机白盒锁定:FullCalendar 定时事件是 `<a class="fc-event">`(cursor:pointer、无
 *   href/role,vanilla JS 驱动)含 `.fc-daygrid-event-dot`(空)+ `.fc-event-time` "4p" +
 *   `.fc-event-title` "Repeating Event",三者皆 cursor:pointer。time/title 两个有文本子
 *   进 cursorPointerExtras → isMultiCtaContainer(kids≥2 + withText≥2 + 非内容卡)误判
 *   `<a>` 为多 CTA 布局容器 → drop `<a>`、保两子 → 一个事件碎成两 ref、"4p" 成误导性局部。
 *
 *   真根因:多 CTA 拆分(#42 班牛 createBox)本为「非交互布局层 div 含多个独立 cursor:pointer
 *   子按钮」设计;原生 <a>/<button>/<summary>/交互 role 是单一复合控件,其 cursor:pointer
 *   子是视觉部件非独立动作,不该拆分。isCompoundControlSelf 在 isMultiCtaContainer 前置否决。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { isCompoundControlSelf, SINGLE_CONTROL_ROLES } from "../src/handlers/observe.js";

describe("isCompoundControlSelf (FullCalendar fc-event 碎片化修复)", () => {
  let document: Document;
  beforeEach(() => {
    document = new JSDOM("<!DOCTYPE html><body></body>").window.document;
  });

  it("<a>(无 href,FullCalendar fc-event)→ 单一复合控件", () => {
    const a = document.createElement("a");
    a.className = "fc-event";
    document.body.appendChild(a);
    expect(isCompoundControlSelf(a)).toBe(true);
  });

  it("<a href> → 单一复合控件", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "#");
    document.body.appendChild(a);
    expect(isCompoundControlSelf(a)).toBe(true);
  });

  it("<button> → 单一复合控件", () => {
    const b = document.createElement("button");
    document.body.appendChild(b);
    expect(isCompoundControlSelf(b)).toBe(true);
  });

  it("<summary> → 单一复合控件", () => {
    const s = document.createElement("summary");
    document.body.appendChild(s);
    expect(isCompoundControlSelf(s)).toBe(true);
  });

  it("[role=button] / [role=link] / [role=tab] → 单一复合控件", () => {
    for (const role of ["button", "link", "tab", "menuitem", "option", "treeitem"]) {
      const d = document.createElement("div");
      d.setAttribute("role", role);
      expect(isCompoundControlSelf(d)).toBe(true);
    }
  });

  it("纯 <div> 布局容器(多 CTA 卡 createBox)→ 非单一控件(仍可拆分)", () => {
    const d = document.createElement("div");
    d.className = "box";
    document.body.appendChild(d);
    expect(isCompoundControlSelf(d)).toBe(false);
  });

  it("<span> / <li> 布局层 → 非单一控件", () => {
    expect(isCompoundControlSelf(document.createElement("span"))).toBe(false);
    expect(isCompoundControlSelf(document.createElement("li"))).toBe(false);
  });

  it("[role=group] / [role=toolbar](布局/分组容器)→ 非单一控件(多 CTA 容器可拆)", () => {
    for (const role of ["group", "toolbar", "list", "region"]) {
      const d = document.createElement("div");
      d.setAttribute("role", role);
      expect(isCompoundControlSelf(d)).toBe(false);
    }
  });

  it("多 token role 取首个(role=\"button x\" → button → 单一控件)", () => {
    const d = document.createElement("div");
    d.setAttribute("role", "button decorative");
    expect(isCompoundControlSelf(d)).toBe(true);
  });

  it("SINGLE_CONTROL_ROLES 含交互 role、不含布局/分组 role", () => {
    expect(SINGLE_CONTROL_ROLES.has("button")).toBe(true);
    expect(SINGLE_CONTROL_ROLES.has("link")).toBe(true);
    expect(SINGLE_CONTROL_ROLES.has("option")).toBe(true);
    expect(SINGLE_CONTROL_ROLES.has("group")).toBe(false);
    expect(SINGLE_CONTROL_ROLES.has("toolbar")).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("inject func 内联 isCompoundControlSelf + isMultiCtaContainer 接入(源码锁,改一处须同步)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );

  it("inject func 含内联 isCompoundControlSelf 定义", () => {
    // 模块级导出 1 处 + inject func 内联 1 处 = 2 处定义
    const count = (SRC.match(/const isCompoundControlSelf = \(anc: Element\): boolean =>/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(SRC).toContain('if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY") return true;');
  });

  it("内联 SINGLE_CONTROL_ROLES 含交互 role(不漂移)", () => {
    const inline = SRC.match(/const SINGLE_CONTROL_ROLES = new Set\(\[([\s\S]*?)\]\)/);
    expect(inline).toBeTruthy();
    for (const r of ["button", "link", "menuitem", "option", "tab", "treeitem"]) {
      expect(inline![1]).toContain(`"${r}"`);
    }
  });

  it("isMultiCtaContainer 前置 isCompoundControlSelf 否决", () => {
    expect(SRC).toMatch(/if \(kids\.length < 2\) return false;[\s\S]{0,200}?if \(isCompoundControlSelf\(anc\)\) return false;/);
  });
});
