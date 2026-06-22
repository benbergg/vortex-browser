import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for the className accessible-name quality fix
 * (preview.pro.ant.design dogfood 2026-06-01).
 *
 * 现象:observe 把非交互背景层 `div.ant-pro-layout-bg-list.css-tql0nm`
 * 误报为可交互 `[div] "css-tql0nm"`。根因在 iconNameFromClass 的 className
 * 兜底:真语义类 `ant-pro-layout-bg-list` 先被 `ant-` 前缀 denylist 否决,
 * 名字级联回退到 emotion token `css-tql0nm`——这个假名又让本应被 BUG-3
 * 噪声过滤器(`!formLike && !hasExplicitRole && !name → continue`)丢弃的
 * 背景层凭非空名续命。
 *
 * 修复:iconNameFromClass 必须否决生成式原子类(emotion `css-*` /
 * styled-components `sc-*`)。否决后该背景层得到空名 → 被噪声过滤器丢弃。
 * 这是「名字质量」修复顺带解决「精度泄漏」的一例。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe className name quality — emotion/generated-class denial (2026-06-01 antd-pro dogfood)", () => {
  it("iconNameFromClass denies emotion `css-*` tokens", () => {
    expect(OBSERVE_SRC).toMatch(/\/\^css-\/\.test\(lower\)/);
  });

  it("iconNameFromClass denies styled-components `sc-*` tokens", () => {
    expect(OBSERVE_SRC).toMatch(/\/\^sc-\[a-z\]\/\.test\(lower\)/);
  });

  it("the emotion/sc denial runs as a `continue` guard before `return cleaned`", () => {
    // 否决必须 continue(跳过该 token),而非污染返回值。
    const denyIdx = OBSERVE_SRC.search(/\/\^css-\/\.test\(lower\)\s*\|\|\s*\/\^sc-\[a-z\]\/\.test\(lower\)\)\s*continue;/);
    expect(denyIdx).toBeGreaterThan(0);
    // 且位于 framework-prefix denylist 之后、`return cleaned` 之前。
    const prefixDenyIdx = OBSERVE_SRC.search(/ICON_CLASS_DENY_PREFIXES\.some/);
    const returnCleanedIdx = OBSERVE_SRC.indexOf("return cleaned;");
    expect(prefixDenyIdx).toBeGreaterThan(0);
    expect(prefixDenyIdx).toBeLessThan(denyIdx);
    expect(denyIdx).toBeLessThan(returnCleanedIdx);
  });
});

/**
 * Regression lock for the lucide/feather svg-icon-library name fix
 * (tiptap.dev dogfood 2026-06-22).
 *
 * 现象:侧栏 chevron 展开按钮(`<button class="p-0.5 rounded ...">` 含
 * `<svg class="lucide lucide-chevron-right">`,无 aria-label/title/text)被
 * observe 命名为 "p-0" —— iconNameFromClass 的 className 兜底用正则
 * `^_?([a-zA-Z][a-zA-Z0-9_-]{2,})` 把 Tailwind 布局类 `p-0.5` 截成噪声名 "p-0",
 * 且从不读 svg 自身的 `lucide-chevron-right` 类(图标语义真源)。
 *
 * 修复:iconNameFromClass 在 className 兜底之前,先读 inner svg 的 class,
 * 命中 `lucide-<name>` / `feather-<name>` 即返回 <name>(hyphen→空格)。
 * lucide 广用于 shadcn/ui 等,svg 类是图标语义的标准载体。
 */
describe("observe svg-icon-library name — lucide/feather svg class reading (2026-06-22 tiptap dogfood)", () => {
  it("iconNameFromClass reads inner svg lucide-/feather- class", () => {
    expect(OBSERVE_SRC).toMatch(/\/\^\(\?:lucide\|feather\)-\(\.\+\)\$\//);
  });

  it("svg-icon-lib reading runs before the className denylist fallback (避免 Tailwind 类泄漏)", () => {
    const svgIconIdx = OBSERVE_SRC.search(/\/\^\(\?:lucide\|feather\)-\(\.\+\)\$\//);
    const classnameFallbackIdx = OBSERVE_SRC.indexOf("// 2. className 兜底");
    expect(svgIconIdx).toBeGreaterThan(0);
    expect(classnameFallbackIdx).toBeGreaterThan(0);
    expect(svgIconIdx).toBeLessThan(classnameFallbackIdx);
  });

  it("仅在 inner.tagName === svg 时读取(不误伤 img alt 路径)", () => {
    expect(OBSERVE_SRC).toMatch(/if \(inner\.tagName === "svg"\) \{[\s\S]*?lucide\|feather[\s\S]*?\}/);
  });
});
