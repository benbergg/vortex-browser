// @vitest-environment jsdom
/**
 * Description: N0002 B003 — pre/code/samp/kbd 的 tabindex=0 仅用于聚焦滚动(常见 dev 文档站
 *   Prism/highlight.js 给 <pre> 加 tabindex="0" 让人能滚长代码块),不是真正可交互控件。
 *   旧逻辑把这些误纳进 ARIA tree,browse 体感噪音巨大。
 *   例外:contenteditable="true"(罕见的 Monaco/CodeMirror 把 pre 设为可编辑)保留为控件。
 *   本测试直测模块级纯导出 isReadonlyScrollTag(tag, contenteditable)。
 */
import { describe, it, expect } from "vitest";
import { isReadonlyScrollTag } from "../src/handlers/observe.js";

describe("observe-readonly-tag: isReadonlyScrollTag (N0002 B003)", () => {
  it("pre + contenteditable=null → true(滚动用)", () => {
    expect(isReadonlyScrollTag("pre", null)).toBe(true);
  });
  it("code + contenteditable=null → true", () => {
    expect(isReadonlyScrollTag("code", null)).toBe(true);
  });
  it("samp + contenteditable=null → true", () => {
    expect(isReadonlyScrollTag("samp", null)).toBe(true);
  });
  it("kbd + contenteditable=null → true", () => {
    expect(isReadonlyScrollTag("kbd", null)).toBe(true);
  });
  it("pre + contenteditable=\"true\" → false(罕见 Monaco/CodeMirror 编辑器)", () => {
    expect(isReadonlyScrollTag("pre", "true")).toBe(false);
  });
  it("pre + contenteditable=\"false\" → true(显式声明不可编辑等同 null)", () => {
    expect(isReadonlyScrollTag("pre", "false")).toBe(true);
  });
  it("button + contenteditable=null → false", () => {
    expect(isReadonlyScrollTag("button", null)).toBe(false);
  });
  it("a + contenteditable=null → false", () => {
    expect(isReadonlyScrollTag("a", null)).toBe(false);
  });
  it("input + contenteditable=null → false", () => {
    expect(isReadonlyScrollTag("input", null)).toBe(false);
  });
  it("div + contenteditable=null → false", () => {
    expect(isReadonlyScrollTag("div", null)).toBe(false);
  });
});