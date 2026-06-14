import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { findDriver } from "../src/patterns/commit-drivers.js";

/**
 * 2026-06-14 真实站评测(react-select.com):fill kind=aria-select 在 react-select 上
 * 实际选中成功(singleValue 显示选中值)却报 COMMIT_FAILED("combobox value shows ''")。
 *
 * 根因:aria-select.ts `root = target.closest(combobox/listbox) ?? target`。observe 的
 * ref 指向 react-select 内层 role="combobox" 的极小 input,input 自身匹配 [role=combobox]
 * → root 塌缩成 input。react-select 选中即 unmount 菜单/选项,而选中值渲染在 input 的
 * **兄弟**(control 容器内的 singleValue),verify 三信号(valueText/inputValues/
 * selectedTexts)全 scope 到塌缩的 input 子树 → 全空 → 假 COMMIT_FAILED。
 * 非对称:trigger 逻辑会爬祖先找可见 control 故点击成功,但 verify 不爬。
 *
 * 本测试用 JSDOM 真实执行 driver(非 source-grep / 非 mock):构造 react-select 结构
 * (control > valueContainer > inputContainer > input[role=combobox],singleValue 选后
 * 插入 valueContainer 并移除 listbox),验证 verify 经祖先 scope 能读到选中值。
 */
const driver = findDriver("aria-select")!;
const CLOSEST = driver.closestSelector;

let dom: JSDOM;

async function loadDriver(): Promise<(sel: string, closest: string, val: unknown, to: number) => Promise<any>> {
  vi.resetModules();
  await import("../src/page-side/commit-drivers/aria-select.js");
  return (window as any).__vortexCommitAriaSelect.run;
}

describe("aria-select verify 经祖先 scope 读 react-select 选中值(@since 2026-06-14)", () => {
  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).Event = dom.window.Event;
    (globalThis as any).MouseEvent = dom.window.MouseEvent;
    // JSDOM getBoundingClientRect 默认全 0 → isVisible 全 false 致 driver 找不到可见
    // trigger/option。打桩成非零矩形,让可见性判定通过(本测试关注 verify scope 非几何)。
    dom.window.Element.prototype.getBoundingClientRect = function (): any {
      return { width: 120, height: 32, top: 0, left: 0, right: 120, bottom: 32, x: 0, y: 0, toJSON() {} };
    };
  });
  afterEach(() => {
    vi.resetModules();
  });

  // 构造 react-select 风格 DOM:选中值在 combobox-input 的祖先容器(control)内,
  // 与 input 是兄弟链关系;选中(option mousedown)后插入 singleValue 并 unmount listbox。
  function buildReactSelectDOM(): void {
    document.body.innerHTML = `
      <div class="rs-container">
        <div class="rs-control">
          <div class="rs-valueContainer">
            <div class="rs-placeholder">Select...</div>
            <div class="rs-inputContainer">
              <input id="cb" role="combobox" aria-expanded="true" value="">
            </div>
          </div>
          <div class="rs-indicators"></div>
        </div>
        <div class="rs-menu" role="listbox" id="lb">
          <div role="option" id="opt-ocean">Ocean</div>
          <div role="option" id="opt-blue">Blue</div>
        </div>
      </div>`;
    const lb = document.getElementById("lb")!;
    const valueContainer = document.querySelector(".rs-valueContainer")!;
    const placeholder = document.querySelector(".rs-placeholder")!;
    // react-select:option mousedown 提交;提交后渲染 singleValue 到 valueContainer
    // 并 unmount 菜单(移除 listbox)。
    for (const opt of Array.from(lb.querySelectorAll('[role="option"]'))) {
      opt.addEventListener("mousedown", () => {
        placeholder.remove();
        const sv = document.createElement("div");
        sv.className = "rs-singleValue";
        sv.textContent = (opt.textContent || "").trim();
        valueContainer.insertBefore(sv, valueContainer.firstChild);
        lb.remove(); // 菜单 unmount —— verify 时 option pool 为空
      });
    }
  }

  it("选中 'Ocean' 成功(选中值在祖先 control 容器,verify 经 scope 上爬读到)", async () => {
    const run = await loadDriver();
    buildReactSelectDOM();
    const out = await run("#cb", CLOSEST, "Ocean", 1500);
    // 修复前:verify scope=塌缩 input → 全空 → COMMIT_FAILED(本断言 RED)
    expect(out.error).toBeUndefined();
    expect(out.result?.success).toBe(true);
    expect(out.result?.clicked).toContain("Ocean");
    // 选中值确实渲染到 singleValue
    expect(document.querySelector(".rs-singleValue")?.textContent).toBe("Ocean");
  });

  it("选不存在的 option 仍正确报错(不被祖先 scope 放宽成假成功)", async () => {
    const run = await loadDriver();
    buildReactSelectDOM();
    const out = await run("#cb", CLOSEST, "Nonexistent", 1200);
    expect(out.result?.success).not.toBe(true);
    expect(out.error).toBeTruthy();
  });
});
