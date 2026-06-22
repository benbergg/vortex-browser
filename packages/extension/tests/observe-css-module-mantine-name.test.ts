import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock：iconNameFromClass 否决 Mantine 框架类 + CSS Modules 打包哈希类
 * (mantine.dev ActionIcon dogfood 2026-06-22)。
 *
 * 现象:Mantine `ActionIcon` 纯图标按钮/链接(LLM 文档 widget)无 aria-label/title/
 * text,svg 无 `<title>`,svg class 是 CSS-module 哈希。observe 把它们命名为
 * `mantine-focus-auto`(className 首 token,Mantine 焦点工具类)——噪声假名,误导 agent。
 *
 * 根因 iconNameFromClass className 兜底:
 *   class="mantine-focus-auto mantine-active MdxLlmAffix-module__OdnXjG__control
 *          m_8d3f4000 mantine-ActionIcon-root m_87cf2631 mantine-UnstyledButton-root"
 *   ① 首 token `mantine-focus-auto` 未被 denylist 覆盖 → 直接返回。
 *   ② 即便否决 `mantine-`,会级联到 `MdxLlmAffix-module__OdnXjG__control`
 *      (CSS Modules `Name-module__HASH__part`)继续泄漏 `mdxllmaffix-module__odnxjg`。
 *
 * 修复(两处,治同一缺陷):
 *   A. `mantine-` 加入 ICON_CLASS_DENY_PREFIXES(与 el-/ant-/van- 同族:组件库前缀类)。
 *   B. CSS Modules 打包哈希类 `-module__<hash>` 加入否决(与 css-/sc- 同族:build 期 scramble)。
 * 二者缺一不可——首 token 是 mantine-(须 A),级联落到 module__(须 B),才得空名 → 诚实无名。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe className name quality — Mantine/CSS-Modules denial (2026-06-22 mantine.dev dogfood)", () => {
  it("ICON_CLASS_DENY_PREFIXES 含 `mantine-`(组件库前缀类)", () => {
    const m = OBSERVE_SRC.match(/const ICON_CLASS_DENY_PREFIXES\s*=\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('"mantine-"');
  });

  it("`mantine-` 与既有 el-/ant-/van- 同列(经统一 prefix denylist 否决)", () => {
    const m = OBSERVE_SRC.match(/const ICON_CLASS_DENY_PREFIXES\s*=\s*\[([^\]]*)\]/);
    const list = m![1];
    for (const p of ['"el-"', '"ant-"', '"van-"', '"mantine-"']) {
      expect(list).toContain(p);
    }
  });

  it("CSS Modules 打包哈希类 `-module__<hash>` 被否决", () => {
    expect(OBSERVE_SRC).toMatch(/\/-module__\[a-z0-9\]\/\.test\(lower\)/);
  });

  it("CSS-module 否决是 `continue` 守卫、位于 css-/sc- 否决之后、`return cleaned` 之前", () => {
    const cssModuleIdx = OBSERVE_SRC.search(/\/-module__\[a-z0-9\]\/\.test\(lower\)\)\s*continue;/);
    const scDenyIdx = OBSERVE_SRC.search(/\/\^sc-\[a-z\]\/\.test\(lower\)/);
    const returnCleanedIdx = OBSERVE_SRC.indexOf("return cleaned;");
    expect(scDenyIdx).toBeGreaterThan(0);
    expect(cssModuleIdx).toBeGreaterThan(scDenyIdx);
    expect(cssModuleIdx).toBeLessThan(returnCleanedIdx);
  });

  it("否决判定不误伤 CSS-module `_closeIcon_1ygkr_39` 这类保留语义首段格式", () => {
    // 该格式(css-loader `_local_hash_seq`)不含 `-module__`,正则不匹配 → 仍正常保留 closeIcon。
    expect(/-module__[a-z0-9]/.test("_closeicon_1ygkr_39")).toBe(false);
    // 而 vanilla-extract/Mantine 格式命中。
    expect(/-module__[a-z0-9]/.test("mdxllmaffix-module__odnxjg")).toBe(true);
    expect(/-module__[a-z0-9]/.test("docsheader-module__yizmww")).toBe(true);
  });
});
