// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { tokensProbeFunc } from "../src/handlers/query.js";

// jsdom 的 getComputedStyle 不枚举自定义属性,按真实 Chrome 的行为造替身:
// 可迭代出属性名 + getPropertyValue 取值(gamma.app 实测 Array.from 可枚举 675 条)。
function makeFake(entries: Array<[string, string]>) {
  const names = entries.map((e) => e[0]);
  const map = new Map(entries);
  return {
    length: names.length,
    opacity: "1",
    getPropertyValue: (p: string) => map.get(p) ?? "",
    [Symbol.iterator]: function* () {
      yield* names;
    },
  };
}

// 自定义属性会继承,真实页面里 body 通常枚举出与 :root 相同的条目。
// 替身必须能分别配置两个 host,否则 roots 断言是重言(评审 Task 4 M-2)。
function stubComputedStyle(
  rootEntries: Array<[string, string]>,
  bodyEntries: Array<[string, string]> = rootEntries,
) {
  vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element) =>
    (el === document.documentElement ? makeFake(rootEntries) : makeFake(bodyEntries)) as never) as never);
}

afterEach(() => vi.restoreAllMocks());

const groupOf = (r: any, name: string): string | undefined =>
  Object.entries(r.groups).find(([, v]: any) => v.some((t: any) => t.name === name))?.[0];

describe("tokensProbeFunc", () => {
  it("按值形态分类:十六进制/rgb/oklch → color", () => {
    stubComputedStyle([
      ["--chakra-colors-deepspace-900", "#00387a"],
      ["--brand", "rgb(5, 64, 173)"],
      ["--accent", "oklch(0.7 0.1 200)"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.color.map((t: any) => t.name).sort()).toEqual([
      "--accent",
      "--brand",
      "--chakra-colors-deepspace-900",
    ]);
    expect(r.groups.color.find((t: any) => t.name === "--chakra-colors-deepspace-900").value).toBe(
      "#00387a",
    );
  });

  it("长度值按名字细分:fontSize / radius / spacing", () => {
    stubComputedStyle([
      ["--chakra-fontSizes-3xl", "1.875rem"],
      ["--radius-lg", "24px"],
      ["--space-4", "1rem"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.fontSize[0].name).toBe("--chakra-fontSizes-3xl");
    expect(r.groups.radius[0].name).toBe("--radius-lg");
    expect(r.groups.spacing[0].name).toBe("--space-4");
  });

  it("cubic-bezier / 时长 → motion", () => {
    stubComputedStyle([
      ["--chakra-transition-easing-ease-out", "cubic-bezier(0, 0, 0.2, 1)"],
      ["--dur-fast", "200ms"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.motion.map((t: any) => t.name).sort()).toEqual([
      "--chakra-transition-easing-ease-out",
      "--dur-fast",
    ]);
  });

  it("分类边界:阴影/渐变/纯色/别名各归各位", () => {
    stubComputedStyle([
      ["--shadow-sm", "0 1px 2px rgba(0, 0, 0, 0.1)"],
      ["--shadow-hex", "0 1px 2px #000000"],
      ["--gradient-hero", "linear-gradient(90deg, #000000, #ffffff)"],
      ["--shadow-color", "rgba(0, 0, 0, 0.1)"],
      ["--shadow-alias", "var(--shadow-sm)"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(groupOf(r, "--shadow-sm")).toBe("shadow");
    expect(groupOf(r, "--shadow-hex")).toBe("shadow");
    expect(groupOf(r, "--gradient-hero")).toBe("gradient");
    // 只有颜色没有长度 = 它就是个颜色 token,按值判为 color 是刻意决定不是意外
    expect(groupOf(r, "--shadow-color")).toBe("color");
    // var() 别名值看不出类型,按名字回落
    expect(groupOf(r, "--shadow-alias")).toBe("shadow");
  });

  it("字体栈 → fontFamily", () => {
    stubComputedStyle([["--font-body", "PPMori, sans-serif"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.fontFamily[0].value).toBe("PPMori, sans-serif");
  });

  it("var() 别名:记录 alias 并按名字归类", () => {
    stubComputedStyle([["--btn-bg-color", "var(--brand-500)"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.groups.color[0].alias).toBe("--brand-500");
  });

  it("pattern 按名字子串过滤(大小写不敏感)", () => {
    stubComputedStyle([
      ["--chakra-colors-a", "#111111"],
      ["--other-color", "#222222"],
    ]);
    const r = tokensProbeFunc("CHAKRA", 50) as any;
    expect(r.total).toBe(1);
    expect(r.groups.color[0].name).toBe("--chakra-colors-a");
  });

  it("maxPerGroup 逐组截断,total 仍是过滤后全量", () => {
    stubComputedStyle([
      ["--c1", "#111111"],
      ["--c2", "#222222"],
      ["--c3", "#333333"],
    ]);
    const r = tokensProbeFunc("*", 2) as any;
    expect(r.total).toBe(3);
    expect(r.showing).toBe(2);
    expect(r.groups.color.length).toBe(2);
  });

  it("body 只是继承 :root → roots 不谎报 body 有贡献", () => {
    // 两个 host 枚举出同样的条目,body 没有任何新增或改写
    stubComputedStyle([["--c1", "#111111"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.roots).toEqual([":root"]);
  });

  it("body 改写了 :root 的值 → roots 记上 body,取 body 的值", () => {
    stubComputedStyle([["--c1", "#111111"]], [["--c1", "#222222"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.roots).toEqual([":root", "body"]);
    expect(r.groups.color[0].value).toBe("#222222");
  });

  it("body 上新增的主题 token 会被收进来", () => {
    stubComputedStyle([["--c1", "#111111"]], [["--c1", "#111111"], ["--c2", "#333333"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.roots).toEqual([":root", "body"]);
    expect(r.total).toBe(2);
  });

  it("截断逐组自陈丢了多少", () => {
    stubComputedStyle([
      ["--c1", "#111111"], ["--c2", "#222222"], ["--c3", "#333333"], ["--c4", "#444444"],
    ]);
    const r = tokensProbeFunc("*", 2) as any;
    expect(r.truncatedGroups).toEqual({ color: 2 });
    expect(r.showing).toBe(2);
    expect(r.total).toBe(4);
  });

  it("pattern 是字面子串不是通配符:'*color*' 命中 0", () => {
    stubComputedStyle([["--chakra-colors-a", "#111111"]]);
    const r = tokensProbeFunc("*color*", 50) as any;
    expect(r.total).toBe(0);
  });

  it("pattern 缺省按全量,不因 undefined 抛错", () => {
    stubComputedStyle([["--c1", "#111111"]]);
    const r = tokensProbeFunc(undefined as never, 50) as any;
    expect(r.total).toBe(1);
  });

  it("分类边界二:border 简写不被吞成 shadow,easing 关键字归 motion", () => {
    stubComputedStyle([
      ["--border-1px", "1px solid #000000"],
      ["--ease", "ease-in-out"],
      ["--ease-linear", "linear"],
      ["--font-weight-bold", "700"],
      ["--z-index-modal", "1400"],
      ["--size-full", "100%"],
      ["--shadow-2", "0 1px 2px 0 rgba(0, 0, 0, 0.1)"],
    ]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(groupOf(r, "--border-1px")).not.toBe("shadow");
    expect(groupOf(r, "--ease")).toBe("motion");
    expect(groupOf(r, "--ease-linear")).toBe("motion");
    expect(groupOf(r, "--font-weight-bold")).toBe("fontWeight");
    expect(groupOf(r, "--z-index-modal")).toBe("other");
    expect(groupOf(r, "--size-full")).toBe("spacing");
    // 真 box-shadow 不能被收紧规则误伤
    expect(groupOf(r, "--shadow-2")).toBe("shadow");
  });

  it("一个 token 都没有 → total=0 且 groups 为空对象", () => {
    stubComputedStyle([]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.total).toBe(0);
    expect(r.groups).toEqual({});
    expect(r.roots).toEqual([]);
    expect(r.truncatedGroups).toEqual({});
  });

  it("注入自包含:剥离模块作用域后仍可运行", () => {
    stubComputedStyle([["--c1", "#111111"]]);
    const detached = new Function("return " + tokensProbeFunc.toString())();
    expect(() => detached("*", 10)).not.toThrow();
  });
});
