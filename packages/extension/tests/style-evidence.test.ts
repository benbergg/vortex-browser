import { describe, it, expect } from "vitest";
import { aggregateFontFaces, buildFontEvidence, isPseudoRendered } from "../src/lib/style-evidence.js";

/** 真站实测的七种形态(gamma.app spike),每条都是真 Chrome 上量到的 computed 值 */
const base = {
  content: '"A"',
  display: "inline",
  visibility: "visible",
  opacity: "1",
  backgroundImage: "none",
  width: "auto",
  height: "auto",
};

describe("isPseudoRendered", () => {
  it("有文字内容且可见 → 渲染", () => {
    expect(isPseudoRendered(base)).toBe(true);
  });

  it("content 是 none → 不渲染(真 Chrome 对无伪元素规则的元素给这个值)", () => {
    expect(isPseudoRendered({ ...base, content: "none" })).toBe(false);
  });

  it("content 是 normal → 不渲染(CSS 规范里伪元素上 normal 计算为 none;jsdom 给的就是它)", () => {
    expect(isPseudoRendered({ ...base, content: "normal" })).toBe(false);
  });

  it("display:none → 不渲染(content 仍是 \"B\",只看 content 会误收)", () => {
    expect(isPseudoRendered({ ...base, content: '"B"', display: "none" })).toBe(false);
  });

  it("visibility:hidden → 不渲染", () => {
    expect(isPseudoRendered({ ...base, content: '"C"', visibility: "hidden" })).toBe(false);
  });

  it("visibility:collapse → 不渲染", () => {
    expect(isPseudoRendered({ ...base, content: '"C"', visibility: "collapse" })).toBe(false);
  });

  it("opacity:0 → 不渲染", () => {
    expect(isPseudoRendered({ ...base, content: '"D"', opacity: "0" })).toBe(false);
  });

  it("空 content + 背景图 + 尺寸 → 渲染(图标块,这是要收的那一类)", () => {
    expect(isPseudoRendered({
      ...base, content: '""', backgroundImage: 'url("data:image/gif;base64,R0lGODlhAQABAAAAACw=")',
      width: "20px", height: "20px", display: "inline-block",
    })).toBe(true);
  });

  it("空 content 且无背景图无尺寸 → 不渲染(什么都不画)", () => {
    expect(isPseudoRendered({ ...base, content: '""' })).toBe(false);
  });

  it("空 content + 无背景图但有尺寸和边框色 → 渲染(纯 CSS 画的分隔条/三角)", () => {
    expect(isPseudoRendered({
      ...base, content: '""', width: "40px", height: "2px", display: "block",
    })).toBe(true);
  });

  it("空 content + 只有背景图、尺寸是 auto → 渲染(背景图那条必须自己承重)", () => {
    expect(isPseudoRendered({
      ...base, content: '""', backgroundImage: 'url("i.png")',
    })).toBe(true);
  });

  it("空 content + 尺寸是 0 → 不渲染(0 不是画得出东西的长度)", () => {
    expect(isPseudoRendered({ ...base, content: '""', width: "0px", height: "0px" })).toBe(false);
  });

  it("空 content + 有宽没高 → 不渲染(单边撑不出可见块)", () => {
    expect(isPseudoRendered({ ...base, content: '""', width: "40px" })).toBe(false);
  });

  it("opacity 是空串(拿不到) → 按可见处理,不因读不到就吞掉元素", () => {
    expect(isPseudoRendered({ ...base, opacity: "" })).toBe(true);
  });
});

describe("buildFontEvidence", () => {
  /** gamma.app 实测:声明 ESBuild,平台名带空格 ES Build */
  const gammaH1 = [{ familyName: "ES Build", postScriptName: "ESBuild-Bold", glyphCount: 56, isCustomFont: true }];

  it("首选字体用上了 → firstChoiceInUse=true(平台名带空格也要认出来)", () => {
    const f = buildFontEvidence("ESBuild, sans-serif", gammaH1);
    expect(f.firstChoiceInUse).toBe(true);
    expect(f.evidence).toBe("cdp-platform-fonts");
    expect(f.rendered).toEqual([
      { family: "ES Build", postScriptName: "ESBuild-Bold", glyphCount: 56, isWebFont: true },
    ]);
  });

  it("首选字体没用上 → false,并如实报出实际渲染的那个", () => {
    // 实测:h1 改 NoSuchFontXYZ, monospace 后 Chrome 用 Menlo 渲染
    const f = buildFontEvidence("NoSuchFontXYZ, monospace", [
      { familyName: "Menlo", postScriptName: "Menlo-Bold", glyphCount: 54, isCustomFont: false },
    ]);
    expect(f.firstChoiceInUse).toBe(false);
    expect(f.rendered![0].family).toBe("Menlo");
    expect(f.rendered![0].isWebFont).toBe(false);
  });

  it("中英混排 → 两个字体都报出来,首选仍算用上(它只渲染了一部分)", () => {
    const f = buildFontEvidence("ESBuild, sans-serif", [
      { familyName: "ES Build", postScriptName: "ESBuild-Bold", glyphCount: 7, isCustomFont: true },
      { familyName: "PingFang SC", postScriptName: "PingFangSC-Semibold", glyphCount: 7, isCustomFont: false },
    ]);
    expect(f.firstChoiceInUse).toBe(true);
    expect(f.rendered).toHaveLength(2);
    expect(f.rendered!.map((r) => r.family)).toContain("PingFang SC");
  });

  it("声明栈带引号 → 引号不参与匹配", () => {
    const f = buildFontEvidence('"PP Mori", sans-serif', [
      { familyName: "PP Mori Medium", postScriptName: "PPMori-Medium", glyphCount: 9, isCustomFont: true },
    ]);
    expect(f.firstChoiceInUse).toBe(true);
  });

  it("元素一个字形都没渲染(空容器) → firstChoiceInUse=null,不能说成'没用上'", () => {
    // 知乎实测:body 只有子元素没有直接文本,rendered 为空。这不是首选字体失效
    const f = buildFontEvidence("Inter, sans-serif", []);
    expect(f.evidence).toBe("cdp-platform-fonts");
    expect(f.rendered).toEqual([]);
    expect(f.firstChoiceInUse).toBeNull();
  });

  it("首选是 -apple-system → null:系统关键字没有对应平台名,不是没用上", () => {
    // 知乎首选就是它;macOS 上实际渲染成 .SF NS,硬比名字必然报 false
    const f = buildFontEvidence('-apple-system, "PingFang SC"', [
      { familyName: ".SF NS", postScriptName: ".SFNS-Regular", glyphCount: 4, isCustomFont: false },
    ]);
    expect(f.firstChoiceInUse).toBeNull();
  });

  it("首选是 BlinkMacSystemFont → 同样按系统关键字处理", () => {
    const f = buildFontEvidence("BlinkMacSystemFont, sans-serif", [
      { familyName: "Helvetica", postScriptName: "Helvetica", glyphCount: 2, isCustomFont: false },
    ]);
    expect(f.firstChoiceInUse).toBeNull();
  });

  it("拿不到(debugger 被占) → rendered=null 且 firstChoiceInUse=null,不谎报 false", () => {
    const f = buildFontEvidence("Inter, sans-serif", null, "debugger busy");
    expect(f.evidence).toBe("unavailable");
    expect(f.rendered).toBeNull();
    expect(f.firstChoiceInUse).toBeNull();
    expect(f.reason).toBe("debugger busy");
  });

  it("firstChoiceInUse 是 null 而不是 false —— JSON 里 false 会被读成'没用上'", () => {
    const f = buildFontEvidence("Inter", null, "x");
    expect(JSON.parse(JSON.stringify(f)).firstChoiceInUse).toBeNull();
  });

  it("声明栈是空的 → 首选无从谈起,给 null 不给 false", () => {
    const f = buildFontEvidence("", gammaH1);
    expect(f.firstChoiceInUse).toBeNull();
  });

  it("Inter 不该匹到 Interstate(postScriptName 主干比对不能退化成前缀匹配)", () => {
    const f = buildFontEvidence("Inter, sans-serif", [
      { familyName: "Interstate", postScriptName: "Interstate-Regular", glyphCount: 12, isCustomFont: true },
    ]);
    expect(f.firstChoiceInUse).toBe(false);
  });

  it("postScriptName 缺失 → 只靠 familyName 比,不因缺字段崩", () => {
    const f = buildFontEvidence("Menlo", [
      { familyName: "Menlo", glyphCount: 3, isCustomFont: false },
    ]);
    expect(f.firstChoiceInUse).toBe(true);
    expect(f.rendered![0].postScriptName).toBe("");
  });

  it("首选是通用族(sans-serif) → 报 null:通用族匹配不到平台名,不能说没用上", () => {
    const f = buildFontEvidence("sans-serif", [
      { familyName: "Helvetica Neue", postScriptName: "HelveticaNeue", glyphCount: 3, isCustomFont: false },
    ]);
    expect(f.firstChoiceInUse).toBeNull();
  });
});

describe("aggregateFontFaces", () => {
  /** 知乎实测:MiSans L3 按 unicode-range 切了 302 片,原样返回 81KB */
  const misans = Array.from({ length: 302 }, (_, i) => ({
    "font-family": '"MiSans L3"',
    src: `local("MiSans L3"), url("fonts/subset-${i}.woff2") format("woff2")`,
    "unicode-range": `U+${i}00-${i}FF`,
    "font-display": "swap",
  }));

  it("同 family 的分片聚合成一条,变体数如实给出", () => {
    const r = aggregateFontFaces(misans);
    expect(r.faces).toHaveLength(1);
    expect(r.faces[0].family).toBe("MiSans L3");
    expect(r.faces[0].variants).toBe(302);
    expect(r.faces[0].subsetted).toBe(true);
  });

  it("聚合后体积必须塌下来(这条爆过 81KB)", () => {
    expect(JSON.stringify(aggregateFontFaces(misans)).length).toBeLessThan(1000);
  });

  it("family 名去引号,与 font-family 声明栈里的写法对齐", () => {
    expect(aggregateFontFaces([{ "font-family": '"PP Mori"', src: "url(a.woff2)" }]).faces[0].family).toBe("PP Mori");
  });

  it("同 family 不同字重 → 字重列表升序去重", () => {
    const r = aggregateFontFaces([
      { "font-family": "ESBuild", src: "url(b.woff2)", "font-weight": "700" },
      { "font-family": "ESBuild", src: "url(a.woff2)", "font-weight": "400" },
      { "font-family": "ESBuild", src: "url(c.woff2)", "font-weight": "400" },
    ]);
    expect(r.faces[0].weights).toEqual(["400", "700"]);
    expect(r.faces[0].variants).toBe(3);
  });

  it("站点没声明字重 → 不输出空数组(知乎实测全空,白占字节)", () => {
    const r = aggregateFontFaces([{ "font-family": "A", src: "url(x)" }]);
    expect(r.faces[0].weights).toBeUndefined();
    expect(r.faces[0].styles).toBeUndefined();
  });

  it("没有 unicode-range → subsetted=false(不是分片,是完整字体)", () => {
    expect(aggregateFontFaces([{ "font-family": "ESBuild", src: "url(a.woff2)" }]).faces[0].subsetted).toBe(false);
  });

  it("保留一条代表 src,借鉴界面要知道字体从哪来", () => {
    const r = aggregateFontFaces([{ "font-family": "ESBuild", src: 'url("/f/ESBuild-Regular.woff2")' }]);
    expect(r.faces[0].src).toContain("/f/ESBuild-Regular.woff2");
  });

  it("family 数超上限 → 截断并自陈,不静默丢", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ "font-family": `F${i}`, src: "url(x)" }));
    const r = aggregateFontFaces(many, 10);
    expect(r.faces).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.totalFamilies).toBe(40);
  });

  it("没超上限 → truncated=false", () => {
    const r = aggregateFontFaces([{ "font-family": "A", src: "url(x)" }], 10);
    expect(r.truncated).toBe(false);
    expect(r.totalFamilies).toBe(1);
  });

  it("变体多的 family 排前面 —— 截断时先留下承重的那个", () => {
    const mixed = [
      { "font-family": "Rare", src: "url(r)" },
      ...Array.from({ length: 5 }, () => ({ "font-family": "Main", src: "url(m)" })),
    ];
    expect(aggregateFontFaces(mixed, 1).faces[0].family).toBe("Main");
  });

  it("缺 font-family 的规则跳过,不产生空 family 条目", () => {
    const r = aggregateFontFaces([{ src: "url(x)" }, { "font-family": "A", src: "url(y)" }]);
    expect(r.faces).toHaveLength(1);
    expect(r.faces[0].family).toBe("A");
  });
});
