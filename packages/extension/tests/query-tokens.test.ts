// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { tokensProbeFunc } from "../src/handlers/query.js";

// jsdom 的 getComputedStyle 不枚举自定义属性,按真实 Chrome 的行为造替身:
// 可迭代出属性名 + getPropertyValue 取值(gamma.app 实测 Array.from 可枚举 675 条)。
function stubComputedStyle(entries: Array<[string, string]>) {
  const names = entries.map(([n]) => n);
  const map = new Map(entries);
  const fake = {
    length: names.length,
    getPropertyValue: (p: string) => map.get(p) ?? "",
    [Symbol.iterator]: function* () {
      yield* names;
    },
  };
  vi.spyOn(window, "getComputedStyle").mockReturnValue(fake as never);
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

  it("roots 如实报告扫了哪些根(召回边界要说出来,不能装作全站)", () => {
    stubComputedStyle([["--c1", "#111111"]]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.roots).toEqual([":root", "body"]);
  });

  it("一个 token 都没有 → total=0 且 groups 为空对象", () => {
    stubComputedStyle([]);
    const r = tokensProbeFunc("*", 50) as any;
    expect(r.total).toBe(0);
    expect(r.groups).toEqual({});
    expect(r.roots).toEqual([]);
  });

  it("注入自包含:剥离模块作用域后仍可运行", () => {
    stubComputedStyle([["--c1", "#111111"]]);
    const detached = new Function("return " + tokensProbeFunc.toString())();
    expect(() => detached("*", 10)).not.toThrow();
  });
});
