// @vitest-environment jsdom
// 锁住 css/geometry/style 三种返回形状,以及统一探针各维度的采集行为。
// 与既有测试的分工:既有测试断言字段"值"是否算对,这里断言返回体"形状"不漂移
// —— 键集合、showing 语义、scanned 自陈,三者既有测试都没覆盖。
import { describe, it, expect, beforeEach } from "vitest";
import { elementsProbeFunc } from "../src/handlers/query.js";
import { shapeCssResult, shapeGeometryResult, shapeStyleResult } from "../src/lib/element-shaping.js";
import { dimensionsForMode } from "../src/lib/element-dimensions.js";

function seed(html: string): void {
  document.body.innerHTML = html;
}

// 老 css/geometry/style 三个探针已删除,这三段改为盯"统一探针+整形层"产出同一形状。
// 这些断言原本是拿老实现当参照的,现在它们自己就是契约 —— 键集合与 showing 语义
// 一旦漂移,下游按老形状写的解析就会静默取空。
describe("css 形状契约", () => {
  beforeEach(() => seed(`<ul><li class="item" href="/a">A</li><li class="item">B</li></ul>`));

  const css = (sel: string, attrs: string[] | null, n: number, inc: boolean) =>
    shapeCssResult(elementsProbeFunc(sel, n, ["text", "attrs"], attrs, inc) as never,
      { attributes: attrs, includeText: inc });

  it("顶层键集合恒为 elements/total/showing/scanned", () => {
    expect(Object.keys(css(".item", null, 10, true)).sort())
      .toEqual(["elements", "scanned", "showing", "total"]);
  });

  it("showing 等于实际返回的元素数,不是命中总数", () => {
    const r = css(".item", null, 1, true);
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });

  it("scanned 三个计数键齐全,零命中时也在", () => {
    const r = css(".nope", null, 10, true);
    expect(r.total).toBe(0);
    expect(Object.keys(r.scanned!).sort()).toEqual(["elements", "iframes", "shadowRoots"]);
    expect(r.scanned!.elements).toBeGreaterThan(0);
  });

  it("元素键集合:不要属性不要文本时只有 index/tag/children_count", () => {
    expect(Object.keys(css(".item", null, 10, false).elements[0]).sort())
      .toEqual(["children_count", "index", "tag"]);
  });
});

describe("geometry 形状契约", () => {
  beforeEach(() => seed(`<div id="a">A</div><div id="b">B</div>`));

  const geo = (sel: string, n: number) =>
    shapeGeometryResult(elementsProbeFunc(sel, n, ["geometry"], null, false) as never);

  it("顶层键集合恒为 viewport/elements/total/showing(+pair 当命中≥2)", () => {
    expect(Object.keys(geo("div", 10)).sort())
      .toEqual(["elements", "pair", "showing", "total", "viewport"]);
  });

  it("命中 1 个时无 pair 键,而不是 pair:undefined", () => {
    const raw = elementsProbeFunc("#a", 10, ["geometry"], null, false) as Record<string, unknown>;
    // 先证明探针没崩:只断言"某键不存在"时,探针抛错返回 {error} 也会让断言通过 ——
    // 实测把 pair 门槛从 >=2 改成 >=1,rects[1] 为 undefined 致探针 catch,这条照样绿。
    expect(raw.error).toBeUndefined();
    const r = shapeGeometryResult(raw as never);
    expect(r.elements).toHaveLength(1);
    expect("pair" in r).toBe(false);
  });

  it("元素键集合固定,occludedBy 未命中时不出现", () => {
    expect(Object.keys(geo("#a", 10).elements[0]).sort()).toEqual(
      ["bbox", "clippedByAncestor", "inViewport", "index", "occluded", "tag", "textClipped"],
    );
  });

  it("showing 受 maxResults 截断而 total 不受", () => {
    const r = geo("div", 1);
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });
});

describe("style 形状契约", () => {
  beforeEach(() => seed(`<p class="t">hello</p>`));

  const style = (sel: string, n: number, groups: string[] | null) => {
    const d = dimensionsForMode("style", groups);
    return shapeStyleResult(elementsProbeFunc(sel, n, d, null, false) as never, d);
  };

  it("顶层含 elements/total/showing,选组决定元素上的组键", () => {
    const r = style(".t", 10, ["typography"]);
    expect(r.total).toBe(1);
    expect(r.showing).toBe(1);
    expect(r.elements[0]).toHaveProperty("typography");
    expect(r.elements[0]).not.toHaveProperty("box");
  });

  it("未选 font 组时不产生 declaredFont/fp 字段", () => {
    const r = style(".t", 10, ["box"]);
    expect("declaredFont" in r.elements[0]).toBe(false);
    expect("fp" in r.elements[0]).toBe(false);
  });

  it("选 font 组时 declaredFont 与 fp 同时出现,fp 是路径形状", () => {
    const r = style(".t", 10, ["font"]) as { elements: Array<{ declaredFont?: string; fp?: string }> };
    expect(typeof r.elements[0].declaredFont).toBe("string");
    expect(r.elements[0].fp).toMatch(/^[A-Z]+:\d/);
  });

  // 老 style 契约里这 12 个键与 groups 无关、恒返回。删掉老探针后没有参照物,
  // 值取自删除前从 styleProbeFunc(".t", 10, []) 实跑导出的基线,不是手推的。
  it("扁平对比度字段与 groups 无关,恒随 mode=style 返回", () => {
    seed(`<p class="t" style="color:#111;background:#fff">hello</p>`);
    for (const groups of [null, [] as string[], ["box"]]) {
      const r = style(".t", 10, groups);
      expect([groups, r.elements[0].contrastStatus, r.elements[0].contrastRatio,
        r.elements[0].wcagAA, r.elements[0].color, r.elements[0].background])
        .toEqual([groups, "ok", 18.88, true, "rgb(17, 17, 17)", "rgb(255, 255, 255)"]);
    }
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

  it("整形结果顶层与元素键集合固定", () => {
    const shaped = shapeGeometryResult(
      elementsProbeFunc("div", 10, ["geometry"], null, false) as never);
    expect(Object.keys(shaped).sort())
      .toEqual(["elements", "pair", "showing", "total", "viewport"]);
    expect(Object.keys(shaped.elements[0]).sort()).toEqual(
      ["bbox", "clippedByAncestor", "inViewport", "index", "occluded", "tag", "textClipped"]);
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

  // children_count 与 attrs/includeText 都无关,四种组合下恒出现且值相同 —— 期望取自
  // 删除老探针前 cssQueryFunc 的实跑基线(五种组合 present=true value=2),不是手推的。
  // 它不属于 text 或 attrs 任一维度,所以在实现里也刻意放在两个 guard 之外。
  it.each([
    { attrs: null as string[] | null, includeText: true, keys: ["children_count", "index", "tag", "text"] },
    { attrs: null as string[] | null, includeText: false, keys: ["children_count", "index", "tag"] },
    { attrs: ["href"], includeText: true, keys: ["attrs", "children_count", "index", "tag", "text"] },
    { attrs: ["href"], includeText: false, keys: ["attrs", "children_count", "index", "tag"] },
    { attrs: [] as string[], includeText: true, keys: ["attrs", "children_count", "index", "tag", "text"] },
  ])("children_count 恒出现 (attrs=$attrs, includeText=$includeText)", ({ attrs, includeText, keys }) => {
    seed(`<ul><li class="item" href="/a"><b>A</b><i>x</i></li><li class="item">B</li></ul>`);
    const shaped = shapeCssResult(
      elementsProbeFunc(".item", 10, ["text", "attrs"], attrs, includeText) as never,
      { attributes: attrs, includeText });
    expect(shaped.elements[0].children_count).toBe(2);
    expect(Object.keys(shaped.elements[0]).sort()).toEqual(keys);
  });

  it("整形结果顶层与元素键集合固定", () => {
    const shaped = shapeCssResult(
      elementsProbeFunc(".item", 10, ["text", "attrs"], ["href"], true) as never,
      { attributes: ["href"], includeText: true });
    expect(Object.keys(shaped).sort()).toEqual(["elements", "scanned", "showing", "total"]);
    expect(Object.keys(shaped.elements[0]).sort())
      .toEqual(["attrs", "children_count", "index", "tag", "text"]);
  });

  // src/href 取 DOM property 拿绝对 URL、表单控件读 live value(用户输入不反射为
  // attribute,getAttribute 返 null)。Task 4 端口一度退化成纯 getAttribute,键一个不少、
  // 值全不同 —— 只比键集合的契约测试五个 Task 都没发现,Task 9 迁移才撞出来。
  it("表单控件读 live value 而非 getAttribute", () => {
    seed(`<form><input class="f" value="init"><input class="f" type="checkbox" checked></form>`);
    (document.querySelectorAll(".f")[0] as HTMLInputElement).value = "用户敲进去的";
    const attrs = ["value", "checked"];
    const shaped = shapeCssResult(
      elementsProbeFunc(".f", 10, ["text", "attrs"], attrs, false) as never,
      { attributes: attrs, includeText: false });
    expect((shaped.elements[0] as { attrs: Record<string, string> }).attrs.value)
      .toBe("用户敲进去的");
    expect((shaped.elements[1] as { attrs: Record<string, string> }).attrs.checked).toBe("true");
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

  it("整形结果元素键集合固定:12 个扁平字段 + 所选两组", () => {
    const dims = dimensionsForMode("style", ["typography", "box"]);
    const shaped = shapeStyleResult(
      elementsProbeFunc(".t", 10, dims, null, false) as never, dims);
    expect(Object.keys(shaped.elements[0]).sort()).toEqual([
      "background", "backgroundImage", "bgFromAncestor", "box", "color", "contrastRatio",
      "contrastStatus", "fontSize", "fontWeight", "index", "tag", "typography",
      "wcagAA", "wcagAAA",
    ]);
    // camelCase→kebab 那次转换掉了的话,键一个不缺、值全是空串
    expect((shaped.elements[0].typography as Record<string, string>).fontSize).toBeTruthy();
    expect((shaped.elements[0].box as Record<string, string>).display).toBeTruthy();
  });

  // 对比度五态是真站上纠正过捏造数字的成果:宽松 parse 会从 oklch 里抓出数字算出
  // 一个看着很正常的比值,键一个不少。期望值取自删除老探针前
  // `styleProbeFunc(".t", 10, [])` 的实跑基线,不是手推的。
  it.each([
    ["color:#111;background:#fff", "ok", 18.88, true, "rgb(17, 17, 17)", "rgb(255, 255, 255)", "none"],
    ["color:#111", "no-painted-background", null, null, "rgb(17, 17, 17)", "rgba(0, 0, 0, 0)", "none"],
    ["color:#111;background:#fff;opacity:.5", "translucent", null, null, "rgb(17, 17, 17)", "rgb(255, 255, 255)", "none"],
    ["color:oklch(.5 .1 200);background:#fff", "unsupported-color", null, null, "oklch(0.5 0.1 200)", "rgb(255, 255, 255)", "none"],
    ["color:#111;background:url(x.png)", "background-image", null, null, "rgb(17, 17, 17)", "rgba(0, 0, 0, 0)", 'url("x.png")'],
  ])("contrast 五态基线:%s", (css, status, ratio, aa, color, bg, bgImg) => {
    seed(`<p class="t" style="${css}">hello</p>`);
    const r = elementsProbeFunc(".t", 10, ["contrast"], null, false) as {
      elements: Array<Record<string, unknown>>;
    };
    const e = r.elements[0];
    expect([e.contrastStatus, e.contrastRatio, e.wcagAA, e.wcagAAA,
      e.color, e.background, e.backgroundImage, e.bgFromAncestor])
      .toEqual([status, ratio, aa, aa, color, bg, bgImg, false]);
  });

  // 背景由渲染树决定,而渲染树是 composed tree —— light DOM 的 parentElement 在
  // shadow 边界就断了。走错树的后果不是"少走几步",是 shadow 内元素永远报
  // no-painted-background,即使 host 明明画着底色。
  describe("contrast 上溯跨 shadow 边界", () => {
    /** host 带底色,目标是它 shadow 里的直接子元素 —— parentElement 立刻为 null */
    function seedShadow(hostCss: string, targetCss: string) {
      document.body.innerHTML = "";
      const host = document.createElement("div");
      host.setAttribute("style", hostCss);
      document.body.appendChild(host);
      host.attachShadow({ mode: "open" }).innerHTML =
        `<span class="t" style="${targetCss}">hi</span>`;
      return host;
    }

    it("host 的底色算进 shadow 内元素的对比度", () => {
      seedShadow("background:#fff", "color:#111");
      const e = (elementsProbeFunc(".t", 10, ["contrast"], null, false) as {
        elements: Array<Record<string, unknown>>;
      }).elements[0];
      expect([e.contrastStatus, e.contrastRatio, e.background, e.bgFromAncestor])
        .toEqual(["ok", 18.88, "rgb(255, 255, 255)", true]);
    });

    it("host 半透明 → shadow 内元素判 translucent,不给假的精确比值", () => {
      seedShadow("background:#fff;opacity:.5", "color:#111");
      const e = (elementsProbeFunc(".t", 10, ["contrast"], null, false) as {
        elements: Array<Record<string, unknown>>;
      }).elements[0];
      expect([e.contrastStatus, e.contrastRatio]).toEqual(["translucent", null]);
    });

    it("整条 composed 链都没绘制背景时仍是 no-painted-background", () => {
      seedShadow("", "color:#111");
      const e = (elementsProbeFunc(".t", 10, ["contrast"], null, false) as {
        elements: Array<Record<string, unknown>>;
      }).elements[0];
      expect([e.contrastStatus, e.bgFromAncestor]).toEqual(["no-painted-background", false]);
    });
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

describe("维度级错误隔离", () => {
  beforeEach(() => seed(`<p class="t boom">a</p><p class="t">b</p>`));

  function failStyleOn(cls: string): () => void {
    const orig = window.getComputedStyle;
    (window as unknown as { getComputedStyle: unknown }).getComputedStyle = function (
      el: Element, pseudo?: string | null,
    ) {
      if ((el as HTMLElement).classList?.contains(cls)) throw new Error("style boom");
      return orig.call(window, el, pseudo ?? undefined);
    };
    return () => { (window as unknown as { getComputedStyle: unknown }).getComputedStyle = orig; };
  }

  // 只替伪元素那一路,元素自身的 computed 仍走真实 jsdom —— 否则连 box 都取不到,
  // 这条测试就变成在测 stub 而不是在测探针。
  function stubPseudoContent(): () => void {
    const orig = window.getComputedStyle;
    (window as unknown as { getComputedStyle: unknown }).getComputedStyle = function (
      el: Element, pseudo?: string | null,
    ) {
      if (!pseudo) return orig.call(window, el, undefined);
      return { getPropertyValue: (p: string) => (p === "content" ? '"x"' : "auto") };
    };
    return () => { (window as unknown as { getComputedStyle: unknown }).getComputedStyle = orig; };
  }

  it("box 维度失败不影响同一元素的 geometry", () => {
    const restore = failStyleOn("boom");
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry", "box"], null, false) as {
        error?: string; elements: Array<Record<string, unknown>>;
      };
      expect(r.error).toBeUndefined();
      expect(r.elements).toHaveLength(2);
      expect(r.elements[0]).toHaveProperty("bbox");
      expect((r.elements[0].errors as Record<string, string>).box).toMatch(/style boom/);
      expect(r.elements[1]).toHaveProperty("box");
      expect("errors" in r.elements[1]).toBe(false);
    } finally { restore(); }
  });

  it("pseudo 组失败不连带丢 box 与 typography", () => {
    const orig = window.getComputedStyle;
    (window as unknown as { getComputedStyle: unknown }).getComputedStyle = function (
      el: Element, pseudo?: string | null,
    ) {
      if (pseudo) throw new Error("pseudo boom");
      return orig.call(window, el, undefined);
    };
    try {
      const r = elementsProbeFunc(".t", 1, ["typography", "box", "pseudo"], null, false) as {
        error?: string; elements: Array<Record<string, unknown>>;
      };
      expect(r.error).toBeUndefined();
      const e = r.elements[0];
      expect((e.errors as Record<string, string>).pseudo).toMatch(/pseudo boom/);
      expect("box" in (e.errors as Record<string, string>)).toBe(false);
      expect("typography" in (e.errors as Record<string, string>)).toBe(false);
      expect(e).toHaveProperty("box");
      expect(e).toHaveProperty("typography");
    } finally { (window as unknown as { getComputedStyle: unknown }).getComputedStyle = orig; }
  });

  it.each([
    ["geometry"], ["text"], ["attrs"], ["contrast"], ["typography"],
    ["box"], ["paint"], ["motion"], ["pseudo"], ["font"],
  ])("请求维度 %s 必须有交代:要么有字段,要么有 errors 条目", (dim) => {
    const FIELD: Record<string, string> = {
      geometry: "bbox", text: "text", attrs: "attrs", font: "declaredFont", pseudo: "pseudoRaw",
      contrast: "color",
    };
    // jsdom 的 getComputedStyle(el,"::before") 不实现伪元素,恒返回 content:"normal",
    // 探针据此判定"页面没有伪元素"而跳过 —— 既无 pseudoRaw 也无 errors。注入 <style>
    // 改变不了这一点(实测),只能替掉 getComputedStyle 才造得出"有伪元素"的局面。
    const restore = dim === "pseudo" ? stubPseudoContent() : (): void => {};
    try {
      const r = elementsProbeFunc(".t", 1, [dim], ["id"], true) as {
        elements: Array<Record<string, unknown>>;
      };
      const e = r.elements[0];
      const key = FIELD[dim] ?? dim;
      const accounted = key in e || Boolean((e.errors as Record<string, string> | undefined)?.[dim]);
      expect(accounted, `维度 ${dim} 既没产出 ${key} 也没记 errors.${dim}`).toBe(true);
    } finally {
      restore();
    }
  });

  it("attrs 失败不连带丢 text", () => {
    const orig = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function (n: string) {
      if (this.classList?.contains("boom")) throw new Error("attr boom");
      return orig.call(this, n);
    };
    try {
      const r = elementsProbeFunc(".t", 2, ["text", "attrs"], ["id"], true) as { elements: Array<Record<string, unknown>> };
      expect(r.elements[0].text).toBe("a");
      expect((r.elements[0].errors as Record<string, string>).attrs).toMatch(/attr boom/);
      expect("text" in (r.elements[0].errors as Record<string, string>)).toBe(false);
    } finally { Element.prototype.getAttribute = orig; }
  });

  it("一个元素 geometry 失败,其他元素仍返回", () => {
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains("boom")) throw new Error("rect boom");
      return orig.call(this);
    };
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry"], null, false) as { error?: string; elements: Array<Record<string, unknown>> };
      expect(r.error).toBeUndefined();
      expect(r.elements).toHaveLength(2);
      expect(r.elements[1]).toHaveProperty("bbox");
    } finally { Element.prototype.getBoundingClientRect = orig; }
  });

  it("首元素 geometry 失败时不产生 pair", () => {
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains("boom")) throw new Error("rect boom");
      return orig.call(this);
    };
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry"], null, false) as Record<string, unknown>;
      expect("pair" in r).toBe(false);
    } finally { Element.prototype.getBoundingClientRect = orig; }
  });

  // 首元素失败那条挡不住下标错位:只有两个元素、第一个失败时,rects 无论补不补占位
  // 都只剩一条,pair 都不会生成 —— 两种实现看起来一样。三个元素、失败的在中间,
  // 错位才现形:rects 变成 [第0个, 第2个],pair 拿第 0 和第 2 个比,还一声不响。
  it("中间元素 geometry 失败时 pair 不得跨过它拿后面的元素来比", () => {
    seed(`<div class="t">a</div><div class="t boom">b</div><div class="t">c</div>`);
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains("boom")) throw new Error("rect boom");
      return orig.call(this);
    };
    try {
      const r = elementsProbeFunc(".t", 3, ["geometry"], null, false) as Record<string, unknown>;
      expect((r.elements as unknown[]).length).toBe(3);
      expect("pair" in r).toBe(false);
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });

  it("样式组失败不阻止 geometry 的 pair 生成", () => {
    const restore = failStyleOn("boom");
    try {
      const r = elementsProbeFunc(".t", 2, ["geometry", "box"], null, false) as Record<string, unknown>;
      expect("pair" in r).toBe(true);
    } finally { restore(); }
  });

  it("选择器非法仍是整请求错误,不降级成逐元素错误", () => {
    const r = elementsProbeFunc("div[[", 10, ["geometry"], null, false) as { error?: string };
    expect(r.error).toMatch(/Invalid CSS selector/);
  });

  it("全部正常时不产生 errors 字段", () => {
    const r = elementsProbeFunc(".t", 2, ["geometry"], null, false) as { elements: Array<Record<string, unknown>> };
    expect("errors" in r.elements[0]).toBe(false);
  });
});
