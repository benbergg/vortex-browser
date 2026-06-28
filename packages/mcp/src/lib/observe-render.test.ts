/**
 * Description: N0002 R1 — renderObserveTree/renderObserveCompact 渲染
 *   [autocomplete=...] 与 [pressed] 两个新 a11y 状态字段。
 *
 *   背景(MUI Autocomplete/各种 a11y 标准角色):
 *   - aria-autocomplete=list/both/none 是 combobox 必报字段,缺它 agent
 *     不知 combobox 弹 listbox 还是 inline;
 *   - aria-pressed=true/false 是 toggle button 的标准状态(MUI ToggleButton、
 *     aria-pressed 字体的 Bold/Italic 按钮),与 [active] 语义不同(active
 *     来自 aria-activedescendant/is-active)。历史 observe.ts:1750 把
 *     aria-pressed 合并到 active 丢 toggle 语义,本次独立。
 *
 *   渲染:与 [level=2] / [haspopup:menu] 同段,贴近现有 flag 风格。
 *   - [autocomplete=list] [autocomplete=both] [autocomplete=none]
 *   - [pressed] (true 时输出,false 不输出避免噪声,与 checked 同步)
 */
import { describe, it, expect } from "vitest";
import { renderObserveTree, renderObserveCompact } from "./observe-render.js";
import type { CompactElement, CompactObserve } from "./observe-render.js";

function mkEl(overrides: Partial<CompactElement>): CompactElement {
  return {
    index: 0,
    tag: "div",
    role: "combobox",
    name: "",
    frameId: 0,
    ...overrides,
  };
}

function mkObserve(elements: CompactElement[]): CompactObserve {
  return {
    snapshotId: "s1",
    url: "https://example.com/",
    frames: [],
    elements,
  };
}

describe("observe-render: aria-autocomplete 渲染 (N0002 R1 B003)", () => {
  it("combobox + state:{autocomplete:'list'} → 输出行含 [autocomplete=list]", () => {
    const out = renderObserveTree(
      mkObserve([mkEl({ index: 0, name: "Country", state: { autocomplete: "list" } })]),
      null,
    );
    expect(out).toMatch(/\[autocomplete=list\]/);
  });

  it("combobox + state:{autocomplete:'both'} → [autocomplete=both]", () => {
    const out = renderObserveTree(
      mkObserve([mkEl({ index: 0, name: "Tag", state: { autocomplete: "both" } })]),
      null,
    );
    expect(out).toMatch(/\[autocomplete=both\]/);
  });

  it("combobox 不带 autocomplete → 不含 [autocomplete=", () => {
    const out = renderObserveTree(
      mkObserve([mkEl({ index: 0, name: "Plain" })]),
      null,
    );
    expect(out).not.toMatch(/\[autocomplete=/);
  });

  it("renderObserveCompact 同样渲染 autocomplete(统一 CompactElement 形状)", () => {
    const out = renderObserveCompact(
      mkObserve([mkEl({ index: 0, name: "C", state: { autocomplete: "list" } })]),
      null,
    );
    expect(out).toMatch(/\[autocomplete=list\]/);
  });
});

describe("observe-render: aria-pressed 独立渲染 (N0002 R1 B004)", () => {
  it("button + state:{pressed:true} → 输出行含 [pressed]", () => {
    const out = renderObserveTree(
      mkObserve([
        { ...mkEl({ index: 0, name: "Bold", role: "button" }), state: { pressed: true } },
      ]),
      null,
    );
    expect(out).toMatch(/\[pressed\]/);
  });

  it("button 不带 pressed → 不含 [pressed]", () => {
    const out = renderObserveTree(
      mkObserve([mkEl({ index: 0, name: "Plain", role: "button" })]),
      null,
    );
    expect(out).not.toMatch(/\[pressed\]/);
  });

  it("renderObserveCompact 同样渲染 pressed", () => {
    const out = renderObserveCompact(
      mkObserve([
        { ...mkEl({ index: 0, name: "Italic", role: "button" }), state: { pressed: true } },
      ]),
      null,
    );
    expect(out).toMatch(/\[pressed\]/);
  });
});
