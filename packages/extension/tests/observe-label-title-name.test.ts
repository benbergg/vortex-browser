import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for the accessible-name fix on icon-only controls whose
 * real name lives on a nested control's aria-label or the element's own
 * `title` attribute (excalidraw dogfood 2026-06-01).
 *
 * 现象:observe 把整条 Excalidraw 主工具栏命名得对 agent 不可用——
 *   - 选择/矩形/椭圆 等 `<label>` 报成快捷键角标 `"1".."0"`(label 的 textContent);
 *   - 锁定/抓手 `<label>` 报成 className `"ToolIcon"`;
 *   - "更多工具" 触发器 `<button>` 报成 className `"dropdown-menu-button"`。
 *
 * 但好名字明明存在:
 *   - label 内嵌 `<input type=radio aria-label="选择">`;
 *   - 每个 label 还有 `title="选择 — V 或 1"`;
 *   - 更多工具按钮有 `title="更多工具"`。
 *
 * 根因:getAccessibleName 的不对称——已有「input 是 surface 元素 → 向上找包裹
 * label」的逻辑,却没有「label 是 surface 元素 → 向下读子控件 aria-label」的反向
 * 逻辑;且 `title` 属性从不作为兜底名源。textContent 的角标数字 "1" 盖过真名,
 * 纯图标 label/button 则直接落到 className hash。
 *
 * 修复:
 *   1. `<label>` 优先取嵌套 input/select/textarea 的 aria-label;
 *   2. `title` 属性作为兜底名源,置于 textContent 之后、className 之前。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe accessible-name — nested-control aria-label + title fallback (2026-06-01 excalidraw dogfood)", () => {
  it("getAccessibleName reads nested labelable control's aria-label for a <label>", () => {
    // label 是 surface 元素时向下读子控件 aria-label,且必须 return 该值。
    expect(OBSERVE_SRC).toMatch(
      /el\.tagName === "LABEL"[\s\S]{0,200}querySelector\("input, select, textarea"\)[\s\S]{0,120}getAttribute\("aria-label"\)/,
    );
    expect(OBSERVE_SRC).toMatch(/if \(ctrlAria\) return normName\(ctrlAria\);/);
  });

  it("the LABEL nested-aria block runs before the textContent fallback (so 角标 '1' doesn't win)", () => {
    const labelIdx = OBSERVE_SRC.search(/if \(el\.tagName === "LABEL"\)/);
    const textIdx = OBSERVE_SRC.search(/const text = normName\(el\.textContent\);/);
    expect(labelIdx).toBeGreaterThan(0);
    expect(textIdx).toBeGreaterThan(0);
    expect(labelIdx).toBeLessThan(textIdx);
  });

  it("getAccessibleName falls back to the `title` attribute before className", () => {
    expect(OBSERVE_SRC).toMatch(
      /const titleAttr = el\.getAttribute\("title"\);\s*\n\s*if \(titleAttr\) return normName\(titleAttr\);/,
    );
  });

  it("the title fallback sits after textContent and before iconNameFromClass", () => {
    const textIdx = OBSERVE_SRC.search(/const text = normName\(el\.textContent\);/);
    const titleIdx = OBSERVE_SRC.search(/const titleAttr = el\.getAttribute\("title"\);/);
    const classIdx = OBSERVE_SRC.indexOf("const fromIcon = iconNameFromClass(el);");
    expect(textIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(classIdx);
  });
});
