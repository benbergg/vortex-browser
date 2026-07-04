import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { findDriver } from "../src/patterns/commit-drivers.js";

/**
 * 2026-07-04 真站评测(newbeta.bytenew.com 工单表新建 dialog):fill kind=select 对班牛
 * el-select(自定义 edit-select 包装,单选已选 label 渲染进只读 <input>.value)实际选中
 * 成功却报 COMMIT_FAILED("trigger shows '"")。
 *
 * 根因:select.ts verify 只回读 wrapper.innerText + .el-tag / .el-select__selected-item /
 * .el-select__tags-text span,三者都不含 <input>.value(input 值从不计入 innerText)。
 * 班牛把单选值渲染进 <input value="处理中"> → displayed="" 且无 selected-item span →
 * notReflected=全部 → 假 COMMIT_FAILED,而 <input>.value 已 commit(query mode=css 证实)。
 * 与 aria-select react-select 假 COMMIT_FAILED 同族(verify 回读面窄于渲染面)。
 *
 * 本测试用 JSDOM 真实执行 driver(非 source-grep / 非 mock):构造 el-select 结构,选中
 * option 后把值写进 trigger 只读 input(不加 selected-item span),验证 verify 经 input
 * 值回读到选中值、返回 success 而非 COMMIT_FAILED。
 */
const driver = findDriver("select")!;
const CLOSEST = driver.closestSelector; // ".el-select"

let dom: JSDOM;

async function loadDriver(): Promise<
  (sel: string, closest: string, val: unknown, to: number) => Promise<any>
> {
  vi.resetModules();
  await import("../src/page-side/commit-drivers/select.js");
  return (window as any).__vortexCommitSelect.run;
}

describe("el-select verify 经 input.value 回读单选已选值(@since 2026-07-04 bytenew)", () => {
  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
    (globalThis as any).Event = dom.window.Event;
    (globalThis as any).MouseEvent = dom.window.MouseEvent;
    // JSDOM getBoundingClientRect 默认全 0 → dropdown 可见性判定失败。打桩非零矩形。
    dom.window.Element.prototype.getBoundingClientRect = function (): any {
      return { width: 160, height: 32, top: 0, left: 0, right: 160, bottom: 32, x: 0, y: 0, toJSON() {} };
    };
    // scrollIntoView 在 JSDOM 未实现
    (dom.window.HTMLElement.prototype as any).scrollIntoView = function () {};
  });
  afterEach(() => {
    vi.resetModules();
  });

  // 班牛风格 el-select:trigger 是只读 <input>,选中后值写进 input.value,无 selected-item span。
  function buildBytenewSelectDOM(): void {
    document.body.innerHTML = `
      <div class="el-select">
        <div class="select-trigger">
          <input id="trigger" class="el-input__inner" readonly value="">
        </div>
        <div class="el-select-dropdown">
          <div class="el-select-dropdown__item">待处理</div>
          <div class="el-select-dropdown__item">处理中</div>
          <div class="el-select-dropdown__item">已完成</div>
        </div>
      </div>`;
    const trigger = document.getElementById("trigger") as HTMLInputElement;
    // 点 option → 把 label 写进 trigger input(模拟班牛 v-model 渲染进只读 input)
    document.querySelectorAll(".el-select-dropdown__item").forEach((it) => {
      it.addEventListener("click", () => {
        trigger.value = (it as HTMLElement).textContent || "";
      });
    });
  }

  it("单选值在只读 input 时返回 success(修复前假报 COMMIT_FAILED)", async () => {
    const run = await loadDriver();
    buildBytenewSelectDOM();
    const res = await run("#trigger", CLOSEST, "处理中", 2000);
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ success: true });
    // 值确已写进 input(自洽)
    expect((document.getElementById("trigger") as HTMLInputElement).value).toBe("处理中");
  });
});
