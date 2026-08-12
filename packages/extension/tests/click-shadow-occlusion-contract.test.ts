/**
 * Run2 iter2 (Shoelace shadow DOM dogfood): sl-option / sl-menu-item 等自带 shadow root
 * 的 web-component 叶子控件,label 经 <slot> 渲染在自身 shadow 内。click 时
 * deepElementFromPoint 钻进 target 自身 shadow 返回内部 slot,而 cdp.ts(useRealMouse)
 * 与 dom.ts(synthetic)的 ELEMENT_OCCLUDED 遮挡检查用 light-DOM `el.contains(topEl)`
 * 不穿 shadow → 误判遮挡。修复:改用穿 shadow 的 composedContains(经 __vortexDomResolve
 * 暴露给注入闭包)。
 *
 * Why source-contract: 两处遮挡检查是 executeScript 注入闭包(MAIN world,丢模块作用域),
 * 不能裸引用模块 helper,且依赖 chrome runtime 无法 jsdom 直接执行;故源码级 contract
 * 锁定「遮挡检查调用 composedContains 而非裸 el.contains(topEl)」。穿 shadow 的行为正确性
 * 由 shadow-walk.test.ts(composedContains 纯函数)+ dom-resolve.test.ts(暴露+穿 shadow)
 * + 真站 live(复点 sl-option)三层覆盖。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_SRC = readFileSync(join(__dirname, "..", "src", "adapter", "cdp.ts"), "utf8");
const DOM_SRC = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");

describe("click 遮挡检查穿 shadow contract (Shoelace sl-option dogfood)", () => {
  it("cdp.ts useRealMouse 遮挡检查调用 composedContains(穿 shadow)", () => {
    expect(CDP_SRC).toMatch(/composedContains/);
  });

  it("cdp.ts 遮挡检查不再用裸 el.contains(topEl)(light-DOM 不穿 shadow)", () => {
    expect(CDP_SRC).not.toMatch(/!el\.contains\(topEl\)/);
  });

  it("dom.ts synthetic click 遮挡检查调用 composedContains(穿 shadow)", () => {
    expect(DOM_SRC).toMatch(/composedContains/);
  });

  it("dom.ts 遮挡检查不再用裸 el.contains(topEl)(light-DOM 不穿 shadow)", () => {
    expect(DOM_SRC).not.toMatch(/!el\.contains\(topEl\)/);
  });
});
