import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:CSS 字体图标按钮(Bootstrap Icons / FontAwesome / Glyphicons)无名
 * (2026-06-03 第十五轮 Monaco editor 真实站 dogfood,AP)。
 *
 * 现象:Monaco playground 的设置按钮 `<button class="btn settings bi-gear">` 图标
 *   经 `::before { content; font-family: bootstrap-icons }` CSS 字形渲染,无 inner
 *   svg/img、无 aria-label/title/text → accessible name 真空,observe 输出无名
 *   `[button]`。iconNameFromClass 开头 `if (!inner) return ""`(要求 inner svg/img)
 *   直接挡死,连带其 className 兜底也吃不到 `bi-gear` 语义类名。Bootstrap Icons /
 *   FontAwesome 这类 CSS 字体图标按钮全网极广,无 aria-label 时整类无名。
 *
 * 修复(Option B,最小风险):仅在 getAccessibleName 的**显示路径**(末位、
 *   isContainer 守卫之后、leaf 元素)加 iconFontName 兜底,按已知 icon-font 前缀
 *   (bi-/fa-/glyphicon-)strip 前缀取图标名;**不碰** cursor:pointer 入池门
 *   (line 969 的 iconNameFromClass),故不新增装饰性元素存活、规避 round-12
 *   幽灵续命风险。FontAwesome 样式修饰类(fa-solid/fa-2x 等)跳过。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe CSS 字体图标按钮命名(AP,2026-06-03 dogfood)", () => {
  it("定义 iconFontName helper,覆盖 bi-/fa-/glyphicon- 已知 icon-font 前缀", () => {
    expect(OBSERVE_SRC).toMatch(/function iconFontName/);
    // 前缀白名单含三大 icon-font 约定。
    expect(OBSERVE_SRC).toMatch(/"bi-"/);
    expect(OBSERVE_SRC).toMatch(/"fa-"/);
    expect(OBSERVE_SRC).toMatch(/"glyphicon-"/);
  });

  it("跳过 FontAwesome 样式修饰类(fa-solid/fa-brands 等非图标名)", () => {
    expect(OBSERVE_SRC).toMatch(/fa-solid/);
    expect(OBSERVE_SRC).toMatch(/ICON_FONT_MODIFIERS/);
  });

  it("iconFontName 接在显示路径(iconNameFromClass 之后作末位兜底)", () => {
    // getAccessibleName 末尾:先 iconNameFromClass 取值,空再 iconFontName 兜底。
    expect(OBSERVE_SRC).toMatch(/const fromIcon = iconNameFromClass\(el\);/);
    expect(OBSERVE_SRC).toMatch(/if \(fromIcon\) return fromIcon;/);
    // 顺序:iconNameFromClass 取值在前,iconFontName 兜底在后。
    const fromIconIdx = OBSERVE_SRC.indexOf("const fromIcon = iconNameFromClass(el);");
    const iconFontIdx = OBSERVE_SRC.indexOf("return iconFontName(el);");
    expect(fromIconIdx).toBeGreaterThan(0);
    expect(iconFontIdx).toBeGreaterThan(fromIconIdx);
  });

  it("cursor:pointer 入池门(line 969)仍只用 iconNameFromClass,不引入 iconFontName(规避 round-12 幽灵续命)", () => {
    // 入池 probe 不得含 iconFontName —— 门行为不变,不新增装饰性元素存活。
    const probeLine = OBSERVE_SRC.match(/const probe = ariaProbe \|\| textProbe \|\| ([^;]+);/);
    expect(probeLine).not.toBeNull();
    expect(probeLine?.[1]).toContain("iconNameFromClass");
    expect(probeLine?.[1]).not.toContain("iconFontName");
  });

  it("ICON_FONT_PREFIXES 含组件库字体图标前缀 vxe-icon- / van-icon-(component-2)", () => {
    expect(OBSERVE_SRC).toMatch(/"vxe-icon-"/);
    expect(OBSERVE_SRC).toMatch(/"van-icon-"/);
  });

  it("班牛 wicon 分支源码锁:仅 wicon 签名基类同在时取 icon- 名", () => {
    expect(OBSERVE_SRC).toMatch(/tokens\.includes\("wicon"\)/);
  });
});

// 行为测试:班牛 web-icon `wicon`+`icon-<name>` 命名(testc dogfood 2026-06-10)。
// 与 observe.ts iconFontName 的 wicon 分支字面一致(真源+测试副本,改一处须同步)。
// `icon-` 前缀须 wicon 锚定——单独 `icon-*` 不取名,避免泛误名装饰图标。
const WICON_BRANCH = `
  const cls = el.className && typeof el.className === "string" ? el.className : "";
  const tokens = cls.split(/\\s+/).filter(Boolean);
  if (tokens.includes("wicon")) {
    for (const c of tokens) {
      const lower = c.toLowerCase();
      if (lower.startsWith("icon-") && lower.length > 5) return lower.slice(5).replace(/-/g, " ");
    }
  }
  return "";
`;
const wiconName = (className: string): string =>
  new Function("el", WICON_BRANCH)({ className });

describe("iconFontName 班牛 wicon 分支(行为)", () => {
  it("wicon + icon-add-1 → 'add 1'", () => {
    expect(wiconName("wicon icon-add-1 w-font-more w-margin-right6")).toBe("add 1");
  });
  it("wicon + icon-more → 'more'", () => {
    expect(wiconName("wicon icon-more w-font-more")).toBe("more");
  });
  it("无 wicon 锚的裸 icon-add-1 → '' (避免泛 icon- 误名装饰图标)", () => {
    expect(wiconName("icon-add-1 some-decorative")).toBe("");
  });
  it("有 wicon 但无 icon- 类 → ''", () => {
    expect(wiconName("wicon w-font-more")).toBe("");
  });
});
