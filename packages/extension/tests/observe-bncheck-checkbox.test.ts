/**
 * Author: qingwa
 * Description: N0064 P2-1 班牛 dogfood —— observe 把 bnCheck 自定义勾选控件识别为
 *   checkbox role + checked 状态。
 *
 *   实机解剖(列表设置弹窗 9 列,2026-06-12):bnCheck 是班牛自定义 Vue 控件,
 *     <div class="bnCheck"><span class="bnCheck-status[ checked]"><span
 *      class="bnCheck-status-inner"/></span><span class="bnCheck-label">名</span></div>
 *   无 role / 无原生 <input> / 无 aria-checked;勾选态 = .bnCheck-status 上的**裸**
 *   `checked` class(蓝),无则未选(灰)。leaf-selection 收 bnCheck-label(span)。
 *
 *   两个缺口:① getRole 返 tag(span);controlRoleFromClass 末位 token 规则抓不到
 *   缩写 "bnCheck"(≠checkbox)。② getUiState 查 is-checked/aria/native 全漏(checked
 *   在后代 status span 的裸 class)。bnCheckInfo 统一识别:上溯命中 .bnCheck 根 →
 *   role=checkbox,checked 读 .bnCheck-status.checked。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { bnCheckInfo } from "../src/handlers/observe.js";

describe("bnCheckInfo (N0064 P2-1: 班牛 bnCheck → checkbox + checked)", () => {
  let document: Document;
  const makeBnCheck = (label: string, checked: boolean): Element => {
    const root = document.createElement("div");
    root.className = "bnCheck w-default-wrap";
    const status = document.createElement("span");
    status.className = checked ? "bnCheck-status checked" : "bnCheck-status";
    const inner = document.createElement("span");
    inner.className = "bnCheck-status-inner";
    status.appendChild(inner);
    const lab = document.createElement("span");
    lab.className = "bnCheck-label";
    lab.textContent = label;
    root.append(status, lab);
    document.body.appendChild(root);
    return root;
  };

  beforeEach(() => {
    document = new JSDOM("<!DOCTYPE html><body></body>").window.document;
  });

  it("从 bnCheck-label(collected leaf)上溯识别为 checkbox", () => {
    const root = makeBnCheck("工单编号", false);
    const label = root.querySelector(".bnCheck-label")!;
    const info = bnCheckInfo(label);
    expect(info).not.toBeNull();
    expect(info!.role).toBe("checkbox");
  });

  it("checked: .bnCheck-status 有 checked class → true", () => {
    const root = makeBnCheck("创建时间", true);
    const label = root.querySelector(".bnCheck-label")!;
    expect(bnCheckInfo(label)!.checked).toBe(true);
  });

  it("unchecked: .bnCheck-status 无 checked class → false", () => {
    const root = makeBnCheck("修改时间", false);
    const label = root.querySelector(".bnCheck-label")!;
    expect(bnCheckInfo(label)!.checked).toBe(false);
  });

  it("bnCheck 根自身也能识别(非仅 label)", () => {
    const root = makeBnCheck("执行人", true);
    expect(bnCheckInfo(root)!.role).toBe("checkbox");
    expect(bnCheckInfo(root)!.checked).toBe(true);
  });

  it("非 bnCheck 元素返 null(普通 cursor:pointer span)", () => {
    const span = document.createElement("span");
    span.className = "w-cursor-pointer";
    span.textContent = "普通文本";
    document.body.appendChild(span);
    expect(bnCheckInfo(span)).toBeNull();
  });

  it("class 前缀相近但非 bnCheck 不误判(bnCheckbox/bnChecklist)", () => {
    const a = document.createElement("div");
    a.className = "bnCheckbox-foo";
    a.textContent = "x";
    document.body.appendChild(a);
    expect(bnCheckInfo(a)).toBeNull();
  });
});

import { readFileSync } from "node:fs";
const OBSERVE_SRC = readFileSync(
  "/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts",
  "utf8",
);

describe("inject func 内联 bnCheckInfo + getRole/getUiState 接入(源码锁,改一处须同步)", () => {
  it("inject func 含内联 bnCheckInfo 定义", () => {
    expect(OBSERVE_SRC).toMatch(/const bnCheckInfo = \(\s*el: Element,?\s*\):/);
  });
  it("getRole 用 bnCheckInfo 返 checkbox", () => {
    expect(OBSERVE_SRC).toMatch(/if \(bnCheckInfo\(el\)\) return "checkbox";/);
  });
  it("getUiState 用 bnCheckInfo 补 checked", () => {
    expect(OBSERVE_SRC).toMatch(/const bn = bnCheckInfo\(el\);\s*\n\s*if \(bn && bn\.checked\) s\.checked = true;/);
  });
  it("bnCheckInfo 出现 ≥2 次(导出真源 + 内联副本)", () => {
    expect((OBSERVE_SRC.match(/bnCheckInfo/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});
