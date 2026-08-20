// @vitest-environment jsdom
// 锁住 css/geometry/style 三个探针的返回形状。整形层重构后这些必须仍绿。
// 与既有测试的分工:既有测试断言字段"值"是否算对,这里断言返回体"形状"不漂移
// —— 键集合、showing 语义、scanned 自陈,三者既有测试都没覆盖。
import { describe, it, expect, beforeEach } from "vitest";
import { cssQueryFunc, geometryProbeFunc, styleProbeFunc, elementsProbeFunc } from "../src/handlers/query.js";

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
    // 先证明探针没崩:只断言"某键不存在"时,探针抛错返回 {error} 也会让断言通过 ——
    // 实测把 pair 门槛从 >=2 改成 >=1,rects[1] 为 undefined 致探针 catch,这条照样绿。
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.elements)).toBe(true);
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

describe("统一探针 geometry 维度", () => {
  beforeEach(() => seed(`<div id="a">A</div><div id="b">B</div>`));

  it("只请求 geometry 时元素上没有文本与属性字段", () => {
    const r = elementsProbeFunc("div", 10, ["geometry"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0]).toHaveProperty("bbox");
    expect("text" in r.elements[0]).toBe(false);
    expect("attrs" in r.elements[0]).toBe(false);
  });

  it("不请求 geometry 时不产生 viewport 与 pair", () => {
    const r = elementsProbeFunc("div", 10, ["text"], null, true) as Record<string, unknown>;
    expect("viewport" in r).toBe(false);
    expect("pair" in r).toBe(false);
  });

  it("scanned 恒产出,与是否请求维度无关(零命中诊断依赖它)", () => {
    const r = elementsProbeFunc(".nope", 10, ["geometry"], null, false) as {
      total: number; scanned: Record<string, number>;
    };
    expect(r.total).toBe(0);
    expect(Object.keys(r.scanned).sort()).toEqual(["elements", "iframes", "shadowRoots"]);
    // 只查键集合是空集假绿:删掉探针里的累加,键还在、值变 0,断言照样通过。
    // 零命中诊断要的正是"搜了多少个都没匹配",没有这条数字断言就证明不了探针在数。
    expect(r.scanned.elements).toBeGreaterThan(0);
  });

  it("非法选择器返回 error 而不是抛出", () => {
    const r = elementsProbeFunc("div[[", 10, ["geometry"], null, false) as { error?: string };
    expect(r.error).toMatch(/Invalid CSS selector/);
  });

  it("经整形层还原后与老 geometry 探针形状一致", async () => {
    const { shapeGeometryResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc("div", 10, ["geometry"], null, false);
    const shaped = shapeGeometryResult(raw as never);
    const legacy = geometryProbeFunc("div", 10) as Record<string, unknown>;
    expect(Object.keys(shaped).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.keys((shaped.elements as Array<Record<string, unknown>>)[0]).sort())
      .toEqual(Object.keys((legacy.elements as Array<Record<string, unknown>>)[0]).sort());
  });
});

describe("统一探针 text/attrs 维度", () => {
  beforeEach(() => seed(`<ul><li class="item" href="/a">A</li><li class="item">B</li></ul>`));

  it("请求 attrs 时按 attributes 白名单取值", () => {
    const r = elementsProbeFunc(".item", 10, ["attrs"], ["href"], false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs).toEqual({ href: "/a" });
    expect(r.elements[1].attrs).toEqual({});
  });

  it("超长属性值截断到 500 字符并加省略号", () => {
    document.querySelector(".item")!.setAttribute("data-x", "y".repeat(600));
    const r = elementsProbeFunc(".item", 10, ["attrs"], ["data-x"], false) as {
      elements: Array<{ attrs?: Record<string, string> }>;
    };
    expect(r.elements[0].attrs!["data-x"]).toHaveLength(503);
    expect(r.elements[0].attrs!["data-x"].endsWith("...")).toBe(true);
  });

  it("请求 text 时带 text 与 children_count", () => {
    const r = elementsProbeFunc(".item", 10, ["text"], null, true) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0].text).toBe("A");
    expect(r.elements[0].children_count).toBe(0);
  });

  it("includeText=false 时即使请求 text 维度也不产 text 字段", () => {
    const r = elementsProbeFunc(".item", 10, ["text"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0]).toHaveProperty("children_count");
    expect("text" in r.elements[0]).toBe(false);
  });

  // children_count 何时出现,老契约里只能拿老探针实测建基线。
  it.each([
    { attrs: null as string[] | null, includeText: true },
    { attrs: null as string[] | null, includeText: false },
    { attrs: ["href"], includeText: true },
    { attrs: ["href"], includeText: false },
    { attrs: [] as string[], includeText: true },
  ])("children_count 出现与否与老 css 探针一致 (attrs=$attrs, includeText=$includeText)", ({ attrs, includeText }) => {
    const legacy = cssQueryFunc(".item", attrs, 10, includeText) as { elements: Array<Record<string, unknown>> };
    const now = elementsProbeFunc(".item", 10, ["text", "attrs"], attrs, includeText) as { elements: Array<Record<string, unknown>> };
    expect("children_count" in now.elements[0]).toBe("children_count" in legacy.elements[0]);
    expect(now.elements[0].children_count).toBe(legacy.elements[0].children_count);
  });

  it("经整形层还原后与老 css 探针形状一致", async () => {
    const { shapeCssResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc(".item", 10, ["text", "attrs"], ["href"], true);
    const shaped = shapeCssResult(raw as never, { attributes: ["href"], includeText: true });
    const legacy = cssQueryFunc(".item", ["href"], 10, true) as Record<string, unknown>;
    expect(Object.keys(shaped).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.keys((shaped.elements as Array<Record<string, unknown>>)[0]).sort())
      .toEqual(Object.keys((legacy.elements as Array<Record<string, unknown>>)[0]).sort());
  });
});

describe("统一探针样式维度", () => {
  beforeEach(() => seed(`<p class="t">hello</p>`));

  it("按组请求,未请求的组不出现", () => {
    const r = elementsProbeFunc(".t", 10, ["typography"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0]).toHaveProperty("typography");
    expect("box" in r.elements[0]).toBe(false);
    expect("paint" in r.elements[0]).toBe(false);
  });

  it("请求 font 组时产出 declaredFont 与 fp,fp 是路径形状供 CDP 对齐", () => {
    const r = elementsProbeFunc(".t", 10, ["font"], null, false) as {
      elements: Array<{ declaredFont?: string; fp?: string }>;
    };
    expect(typeof r.elements[0].declaredFont).toBe("string");
    expect(r.elements[0].fp).toMatch(/^[A-Z]+:\d/);
  });

  it("多个元素的 fp 互不相同,否则 CDP 对齐会误判为碰撞", () => {
    seed(`<p class="t">a</p><p class="t">b</p>`);
    const r = elementsProbeFunc(".t", 10, ["font"], null, false) as {
      elements: Array<{ fp?: string }>;
    };
    expect(r.elements[0].fp).not.toBe(r.elements[1].fp);
  });

  it("geometry 与样式组可同时请求,两者字段共存于同一元素", () => {
    const r = elementsProbeFunc(".t", 10, ["geometry", "box"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(r.elements[0]).toHaveProperty("bbox");
    expect(r.elements[0]).toHaveProperty("box");
    expect(r.elements[0].index).toBe(0);
  });

  it("经整形层还原后与老 style 探针形状一致", async () => {
    const { shapeStyleResult } = await import("../src/lib/element-shaping.js");
    const { dimensionsForMode } = await import("../src/lib/element-dimensions.js");
    const dims = dimensionsForMode("style", ["typography", "box"]);
    const raw = elementsProbeFunc(".t", 10, dims, null, false);
    const shaped = shapeStyleResult(raw as never, dims);
    const legacy = styleProbeFunc(".t", 10, ["typography", "box"]) as Record<string, unknown>;
    // 逐值而非只比键集合:pickProps 少做一次 camelCase→kebab 转换,键一个不缺、值全是空串
    expect((shaped.elements as Array<Record<string, unknown>>)[0])
      .toEqual((legacy.elements as Array<Record<string, unknown>>)[0]);
  });

  // 只比键集合挡不住"把 parseStrict 换成宽松 parse"这类改写:键一个不少,数字全错。
  // 对比度五态是真站上纠正过捏造数字的成果,必须逐值对齐老探针。
  it.each([
    ["ok", "color:#111;background:#fff"],
    ["no-painted-background", "color:#111"],
    ["translucent", "color:#111;background:#fff;opacity:.5"],
    ["unsupported-color", "color:oklch(.5 .1 200);background:#fff"],
    ["background-image", "color:#111;background:url(x.png)"],
  ])("contrast 维度逐值对齐老探针:%s", (_name, css) => {
    seed(`<p class="t" style="${css}">hello</p>`);
    const raw = elementsProbeFunc(".t", 10, ["contrast"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    const legacy = styleProbeFunc(".t", 10, []) as { elements: Array<Record<string, unknown>> };
    for (const k of ["contrastStatus", "contrastRatio", "wcagAA", "wcagAAA",
      "color", "background", "backgroundImage", "bgFromAncestor"]) {
      expect([k, raw.elements[0][k]]).toEqual([k, legacy.elements[0][k]]);
    }
  });

  it("未请求 contrast 时不做上溯,扁平对比度字段一个都不出现", () => {
    const r = elementsProbeFunc(".t", 10, ["box"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    for (const k of ["color", "background", "contrastRatio", "contrastStatus", "wcagAA"]) {
      expect(k in r.elements[0]).toBe(false);
    }
  });

  it("注入自包含:九维度全开剥离模块作用域后仍可运行", () => {
    const detached = new Function("return " + elementsProbeFunc.toString())();
    const st = document.createElement("style");
    st.textContent = '@font-face{font-family:"X";src:url(x.woff2)}';
    document.head.appendChild(st);
    const el = document.createElement("div");
    el.className = "iso-all";
    document.body.appendChild(el);
    let out: unknown;
    expect(() => {
      out = detached(".iso-all", 1,
        ["geometry", "text", "attrs", "contrast", "typography", "box", "paint", "motion",
          "pseudo", "font"],
        ["id"], true);
    }).not.toThrow();
    expect((out as { error?: string }).error).toBeUndefined();
    expect((out as { fontFaces?: unknown[] }).fontFaces).toBeDefined();
  });
});

describe("style 转发的下标不变量", () => {
  beforeEach(() => seed(`<p class="t">a</p><p class="t">b</p><p class="t">c</p>`));

  it("整形前后元素数量、顺序、fp 逐位一致", async () => {
    const { shapeStyleResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc(".t", 10, ["font"], null, false) as {
      elements: Array<{ fp?: string }>;
    };
    const shaped = shapeStyleResult(raw as never, ["font"]);
    expect(shaped.elements).toHaveLength(raw.elements.length);
    expect(shaped.elements.map((e) => e.fp)).toEqual(raw.elements.map((e) => e.fp));
  });

  it("maxResults 截断后,整形结果与探针看到的是同一批元素", async () => {
    const { shapeStyleResult } = await import("../src/lib/element-shaping.js");
    const raw = elementsProbeFunc(".t", 2, ["font"], null, false) as {
      elements: Array<{ fp?: string }>; total: number; showing: number;
    };
    expect(raw.total).toBe(3);
    expect(raw.showing).toBe(2);
    const shaped = shapeStyleResult(raw as never, ["font"]);
    expect(shaped.elements).toHaveLength(2);
    expect(shaped.total).toBe(3);
  });
});
