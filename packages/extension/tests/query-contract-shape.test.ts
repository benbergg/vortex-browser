// @vitest-environment jsdom
// 锁住 css/geometry/style 三个探针的返回形状。整形层重构后这些必须仍绿。
// 与既有测试的分工:既有测试断言字段"值"是否算对,这里断言返回体"形状"不漂移
// —— 键集合、showing 语义、scanned 自陈,三者既有测试都没覆盖。
import { describe, it, expect, beforeEach } from "vitest";
import { cssQueryFunc, geometryProbeFunc, styleProbeFunc } from "../src/handlers/query.js";

function seed(html: string): void {
  document.body.innerHTML = html;
}

describe("css 探针返回形状", () => {
  beforeEach(() => seed(`<ul><li class="item" href="/a">A</li><li class="item">B</li></ul>`));

  it("顶层键集合恒为 elements/total/showing/scanned", () => {
    const r = cssQueryFunc(".item", null, 10, true) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["elements", "scanned", "showing", "total"]);
  });

  it("showing 等于实际返回的元素数,不是命中总数", () => {
    const r = cssQueryFunc(".item", null, 1, true) as { total: number; showing: number; elements: unknown[] };
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });

  it("scanned 三个计数键齐全,零命中时也在", () => {
    const r = cssQueryFunc(".nope", null, 10, true) as { total: number; scanned: Record<string, number> };
    expect(r.total).toBe(0);
    expect(Object.keys(r.scanned).sort()).toEqual(["elements", "iframes", "shadowRoots"]);
    expect(r.scanned.elements).toBeGreaterThan(0);
  });

  it("元素键集合:不要属性不要文本时只有 index/tag/children_count", () => {
    const r = cssQueryFunc(".item", null, 10, false) as { elements: Array<Record<string, unknown>> };
    expect(Object.keys(r.elements[0]).sort()).toEqual(["children_count", "index", "tag"]);
  });
});

describe("geometry 探针返回形状", () => {
  beforeEach(() => seed(`<div id="a">A</div><div id="b">B</div>`));

  it("顶层键集合恒为 viewport/elements/total/showing(+pair 当命中≥2)", () => {
    const r = geometryProbeFunc("div", 10) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["elements", "pair", "showing", "total", "viewport"]);
  });

  it("命中 1 个时无 pair 键,而不是 pair:undefined", () => {
    const r = geometryProbeFunc("#a", 10) as Record<string, unknown>;
    expect("pair" in r).toBe(false);
  });

  it("元素键集合固定,occludedBy 未命中时不出现", () => {
    const r = geometryProbeFunc("#a", 10) as { elements: Array<Record<string, unknown>> };
    expect(Object.keys(r.elements[0]).sort()).toEqual(
      ["bbox", "clippedByAncestor", "inViewport", "index", "occluded", "tag", "textClipped"],
    );
  });

  it("showing 受 maxResults 截断而 total 不受", () => {
    const r = geometryProbeFunc("div", 1) as { total: number; showing: number; elements: unknown[] };
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });
});

describe("style 探针返回形状", () => {
  beforeEach(() => seed(`<p class="t">hello</p>`));

  it("顶层含 elements/total/showing,选组决定元素上的组键", () => {
    const r = styleProbeFunc(".t", 10, ["typography"]) as {
      elements: Array<Record<string, unknown>>; total: number; showing: number;
    };
    expect(r.total).toBe(1);
    expect(r.showing).toBe(1);
    expect(r.elements[0]).toHaveProperty("typography");
    expect(r.elements[0]).not.toHaveProperty("box");
  });

  it("未选 font 组时不产生 declaredFont/fp 字段", () => {
    const r = styleProbeFunc(".t", 10, ["box"]) as { elements: Array<Record<string, unknown>> };
    expect("declaredFont" in r.elements[0]).toBe(false);
    expect("fp" in r.elements[0]).toBe(false);
  });

  it("选 font 组时 declaredFont 与 fp 同时出现,fp 是路径形状", () => {
    const r = styleProbeFunc(".t", 10, ["font"]) as { elements: Array<{ declaredFont?: string; fp?: string }> };
    expect(typeof r.elements[0].declaredFont).toBe("string");
    expect(r.elements[0].fp).toMatch(/^[A-Z]+:\d/);
  });
});
