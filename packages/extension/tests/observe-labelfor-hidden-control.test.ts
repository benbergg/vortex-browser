import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-lock:label[for]→零尺寸 control 命名继承
 * (2026-06-23 mantine.dev/core/rating dogfood).
 *
 * Mantine Rating(及 CSS-only 自定义 radio)把真 radio 设为 0x0(被尺寸门跳过),
 * 用可见的 <label for=radioId> 星星承接点击。label 有 cursor:pointer 但无
 * 文本/aria-label,被 require-name 门丢弃 → 整个评分控件对 observe 隐形。
 *
 * 修复:labelForHiddenControlName 从关联控件继承 aria-label/value 作为 label 的
 * 可及名,在 probe 门(让 label 过 require-name)与 getAccessibleName(输出名)两处
 * 共用。限定零尺寸控件:可见控件自己召回,label 不代理(防双现)。
 *
 * source-level 因 scan 内联于 executeScript;真行为在 mantine.dev/core/rating live 验证。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe label[for]→零尺寸 control 命名继承(source-lock)", () => {
  it("定义 labelForHiddenControlName helper", () => {
    expect(OBSERVE_SRC).toMatch(/function labelForHiddenControlName\(el: Element\): string/);
  });

  it("仅 LABEL 元素 + 有 for 属性才处理", () => {
    expect(OBSERVE_SRC).toMatch(/if \(el\.tagName !== "LABEL"\) return "";/);
    expect(OBSERVE_SRC).toMatch(/const forId = el\.getAttribute\("for"\);/);
  });

  it("零尺寸守卫:可见 control 不代理(防双现)", () => {
    expect(OBSERVE_SRC).toMatch(/offsetWidth !== 0 \|\| h\.offsetHeight !== 0\)\s*return "";/);
  });

  it("name 取关联控件 aria-label 优先、value 兜底", () => {
    expect(OBSERVE_SRC).toMatch(
      /getAttribute\("aria-label"\) \|\| \(h as HTMLInputElement\)\.value/,
    );
  });

  it("root.getRootNode 解析支持 shadow 内 label[for]", () => {
    expect(OBSERVE_SRC).toMatch(/const root = el\.getRootNode\(\) as Document \| ShadowRoot;/);
  });

  it("probe 门调用 helper(让无名 label 过 require-name)", () => {
    expect(OBSERVE_SRC).toMatch(
      /controlRoleFromClass\(el\) \|\| labelForHiddenControlName\(el\)/,
    );
  });

  it("getAccessibleName 输出也调用 helper(门与输出一致)", () => {
    expect(OBSERVE_SRC).toMatch(/const __hiddenCtrlName = labelForHiddenControlName\(el\);/);
    expect(OBSERVE_SRC).toMatch(/if \(__hiddenCtrlName\) return __hiddenCtrlName;/);
  });
});
