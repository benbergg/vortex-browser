import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:buildSelector 的 id / testid 分支必须校验选择器在文档内唯一,否则
 * 重复 id(Modal+页面同 #name,无效 HTML 但真实应用常见)会让 observe 给弹层
 * input 存 #name,下游 querySelector 命中第一个(弹层背后被 mask 遮挡)元素 →
 * actionability OBSCURED。(2026-06-13 antd Pro dogfood A1)
 * 源码级:沿用 observe-shadow-selector.test.ts 约定(buildSelector 深嵌于 scan
 * IIFE,带 stampRid/ariaLabelCount 闭包依赖,功能级提取成本高且无收益)。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "../src/handlers/observe.ts"),
  "utf8",
);

describe("observe buildSelector id/testid 唯一性守卫 (A1 重复 #id 弹层 OBSCURED)", () => {
  it("id 分支返回 #id 前用 querySelectorAll(`#${CSS.escape(el.id)}`).length === 1 守卫", () => {
    expect(OBSERVE_SRC).toMatch(
      /querySelectorAll\(`#\$\{CSS\.escape\(el\.id\)\}`\)\.length === 1[\s\S]{0,60}?return `#\$\{CSS\.escape\(el\.id\)\}`/,
    );
  });

  it("testid 分支返回前同样有 querySelectorAll(...).length === 1 唯一性守卫", () => {
    expect(OBSERVE_SRC).toMatch(
      /data-testid[\s\S]{0,400}?querySelectorAll\(testSel\)\.length === 1[\s\S]{0,40}?return testSel/,
    );
  });
});
