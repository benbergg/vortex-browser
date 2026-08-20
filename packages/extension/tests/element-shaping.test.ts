import { describe, it, expect } from "vitest";
import { normalizeDimensions, dimensionsForMode, ALL_DIMENSIONS } from "../src/lib/element-dimensions.js";
import { shapeCssResult, shapeGeometryResult, shapeStyleResult } from "../src/lib/element-shaping.js";

const RAW = {
  elements: [
    {
      index: 0, tag: "li",
      text: "A", children_count: 0, attrs: { href: "/a" },
      bbox: [0, 0, 10, 10], inViewport: true, occluded: false,
      textClipped: false, clippedByAncestor: false,
      typography: { fontSize: "16px" }, box: { display: "block" },
      declaredFont: "Inter", fp: "LI:0",
    },
    {
      index: 1, tag: "li",
      text: "B", children_count: 0, attrs: {},
      bbox: [0, 20, 10, 10], inViewport: true, occluded: true, occludedBy: "div#mask",
      textClipped: false, clippedByAncestor: false,
      typography: { fontSize: "16px" }, box: { display: "block" },
      declaredFont: "Inter", fp: "LI:1",
    },
  ],
  total: 2, showing: 2,
  viewport: { w: 800, h: 600 },
  pair: { overlap: false, aAboveB: true },
  scanned: { elements: 12, shadowRoots: 0, iframes: 0 },
};

describe("normalizeDimensions", () => {
  it("接受逗号与竖线分隔,去空白", () => {
    expect(normalizeDimensions("geometry|text, box")).toEqual(["geometry", "text", "box"]);
  });

  it("未传返回 null,让调用方决定默认值", () => {
    expect(normalizeDimensions(undefined)).toBeNull();
  });

  it("全是空白时返回 null,而不是空数组", () => {
    expect(normalizeDimensions(" , | ")).toBeNull();
  });
});

describe("dimensionsForMode", () => {
  it("css 翻译成 text+attrs", () => {
    expect(dimensionsForMode("css", null).sort()).toEqual(["attrs", "text"]);
  });

  it("geometry 翻译成 geometry 单维", () => {
    expect(dimensionsForMode("geometry", null)).toEqual(["geometry"]);
  });

  it("style 原样透传所选样式组", () => {
    expect(dimensionsForMode("style", ["box", "font"]).sort()).toEqual(["box", "font"]);
  });

  it("每个 style 组名都在 ALL_DIMENSIONS 里,否则组合模式无法请求它", () => {
    for (const g of ["typography", "box", "paint", "motion", "pseudo", "font"]) {
      expect(ALL_DIMENSIONS).toContain(g);
    }
  });
});

describe("shapeCssResult", () => {
  it("只留 css 契约字段,几何与样式字段被剥掉", () => {
    const r = shapeCssResult(RAW, { attributes: ["href"], includeText: true });
    expect(Object.keys(r.elements[0]).sort()).toEqual(["attrs", "children_count", "index", "tag", "text"]);
    expect(Object.keys(r).sort()).toEqual(["elements", "scanned", "showing", "total"]);
  });

  it("includeText=false 时不带 text 键", () => {
    const r = shapeCssResult(RAW, { attributes: null, includeText: false });
    expect(r.elements).toHaveLength(2);
    expect("text" in r.elements[0]).toBe(false);
  });

  it("attributes=null 时不带 attrs 键", () => {
    const r = shapeCssResult(RAW, { attributes: null, includeText: true });
    expect(r.elements).toHaveLength(2);
    expect("attrs" in r.elements[0]).toBe(false);
  });

  it("attrs 为空对象时仍保留该键,不省略", () => {
    const r = shapeCssResult(RAW, { attributes: ["href"], includeText: true });
    expect(r.elements).toHaveLength(2);
    expect(r.elements[1].attrs).toEqual({});
  });

  it("scanned 原样透传,零命中诊断依赖它", () => {
    expect(shapeCssResult(RAW, { attributes: null, includeText: true }).scanned)
      .toEqual({ elements: 12, shadowRoots: 0, iframes: 0 });
  });
});

describe("shapeGeometryResult", () => {
  it("只留 geometry 契约字段", () => {
    const r = shapeGeometryResult(RAW);
    expect(Object.keys(r.elements[0]).sort()).toEqual(
      ["bbox", "clippedByAncestor", "inViewport", "index", "occluded", "tag", "textClipped"],
    );
  });

  it("occludedBy 有值才出现", () => {
    const r = shapeGeometryResult(RAW);
    expect(r.elements).toHaveLength(2);
    expect("occludedBy" in r.elements[0]).toBe(false);
    expect(r.elements[1].occludedBy).toBe("div#mask");
  });

  it("pair 缺席时不产生该键", () => {
    const r = shapeGeometryResult({ ...RAW, pair: undefined });
    expect(r.elements).toHaveLength(2);
    expect("pair" in r).toBe(false);
  });

  it("顶层键集合与老契约一致", () => {
    expect(Object.keys(shapeGeometryResult(RAW)).sort())
      .toEqual(["elements", "pair", "showing", "total", "viewport"]);
  });
});

describe("shapeStyleResult", () => {
  it("只留所选组,未选的组被剥掉", () => {
    const r = shapeStyleResult(RAW, ["typography"]);
    expect(r.elements).toHaveLength(2);
    expect(r.elements[0]).toHaveProperty("typography");
    expect(r.elements[0]).not.toHaveProperty("box");
    expect(r.elements[0]).not.toHaveProperty("bbox");
  });

  it("未选 font 时剥掉 declaredFont 与 fp", () => {
    const r = shapeStyleResult(RAW, ["box"]);
    expect(r.elements).toHaveLength(2);
    expect(r.elements[0]).toHaveProperty("box");
    expect("declaredFont" in r.elements[0]).toBe(false);
    expect("fp" in r.elements[0]).toBe(false);
  });

  it("选 font 时保留 declaredFont 与 fp 供 CDP 对齐", () => {
    const r = shapeStyleResult(RAW, ["font"]);
    expect(r.elements).toHaveLength(2);
    expect(r.elements[0].declaredFont).toBe("Inter");
    expect(r.elements[0].fp).toBe("LI:0");
  });

  it("未选 pseudo 时剥掉 pseudoRaw,它是内部中间字段不该外泄", () => {
    const withPseudo = {
      ...RAW,
      elements: RAW.elements.map((e) => ({ ...e, pseudoRaw: { "::before": { content: '"x"' } } })),
    };
    const dropped = shapeStyleResult(withPseudo, ["box"]);
    const kept = shapeStyleResult(withPseudo, ["pseudo"]);
    expect(dropped.elements).toHaveLength(2);
    expect(dropped.elements[0]).toHaveProperty("box");
    expect("pseudoRaw" in dropped.elements[0]).toBe(false);
    expect(kept.elements[0]).toHaveProperty("pseudoRaw");
  });

  it("整形不改变元素数量与顺序,fp 逐位对齐", () => {
    const shaped = shapeStyleResult(RAW, ["font"]);
    expect(shaped.elements).toHaveLength(RAW.elements.length);
    expect(shaped.elements.map((e) => e.fp)).toEqual(RAW.elements.map((e) => e.fp));
    expect(shaped.elements.map((e) => e.index)).toEqual([0, 1]);
  });

  // fixture 里每个元素都有 fp,所以 filter(e => e.fp) 型变异一个都滤不掉、测不出来。
  // 未请求 font 维度时探针本就不设 fp,这才是"整形不许丢元素"真正会被违反的场景。
  it("元素缺 fp 时也不能被丢掉,未请求 font 维度的探针输出就没有 fp", () => {
    const noFp = {
      ...RAW,
      elements: RAW.elements.map((e) => {
        const copy: Record<string, unknown> = { ...e };
        delete copy.fp;
        delete copy.declaredFont;
        return copy as typeof e;
      }),
    };
    const shaped = shapeStyleResult(noFp, ["box"]);
    expect(shaped.elements).toHaveLength(2);
    expect(shaped.elements.map((e) => e.index)).toEqual([0, 1]);
  });

  it("index 与 tag 恒保留,身份不能被剥掉", () => {
    for (const groups of [["box"], ["font"], ["typography", "paint"]]) {
      const r = shapeStyleResult(RAW, groups);
      expect(r.elements[0].index).toBe(0);
      expect(r.elements[0].tag).toBe("li");
    }
  });
});
