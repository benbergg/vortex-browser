/**
 * Description: N0002 B001 — renderObserveTree 渲染 aria-level 字段。
 *   树形结构(aria-tree / treeitem)与 heading(role=heading + aria-level)需要把层级数字
 *   透给 agent,否则 LLM 看一堆同 role "treeitem" 无法判断父子层级关系。
 *   渲染:[level=2] 与 [haspopup:menu] / [sort:asc] 等同段,贴近现有 flag 风格。
 */
import { describe, it, expect } from "vitest";
import { renderObserveTree, renderObserveCompact } from "./observe-render.js";
import type { CompactElement, CompactObserve } from "./observe-render.js";

function mkEl(overrides: Partial<CompactElement>): CompactElement {
  return {
    index: 0,
    tag: "div",
    role: "treeitem",
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

describe("observe-render: aria-level 渲染 (N0002 B001)", () => {
  it("treeitem 带 state:{level:2} → 输出行含 [level=2]", () => {
    const out = renderObserveTree(
      mkObserve([mkEl({ index: 0, name: "Root", state: { level: 2 } })]),
      null,
    );
    expect(out).toMatch(/\[level=2\]/);
  });

  it("treeitem 不带 level → 输出行不含 [level=", () => {
    const out = renderObserveTree(
      mkObserve([mkEl({ index: 0, name: "Plain", state: { selected: true } })]),
      null,
    );
    expect(out).not.toMatch(/\[level=/);
  });

  it("state 完全缺省 → 输出行不含 [level=", () => {
    const out = renderObserveTree(mkObserve([mkEl({ index: 0, name: "NoState" })]), null);
    expect(out).not.toMatch(/\[level=/);
  });

  it("level=0 仍渲染(0 是合法 aria-level,表示 outermost)", () => {
    const out = renderObserveTree(
      mkObserve([mkEl({ index: 0, name: "Outermost", state: { level: 0 } })]),
      null,
    );
    expect(out).toMatch(/\[level=0\]/);
  });

  it("level 与其他 state flag 共存(checked) → 两个 flag 都出现", () => {
    const out = renderObserveTree(
      mkObserve([
        mkEl({
          index: 0,
          name: "Checked treeitem",
          state: { level: 3, checked: true },
        }),
      ]),
      null,
    );
    expect(out).toMatch(/\[level=3\]/);
    expect(out).toMatch(/\[checked\]/);
  });

  it("renderObserveCompact 同样渲染 level(非 tree 路径也需,因 CompactElement 是统一形状)", () => {
    const out = renderObserveCompact(
      mkObserve([mkEl({ index: 0, name: "C", state: { level: 4 } })]),
      null,
    );
    expect(out).toMatch(/\[level=4\]/);
  });
});