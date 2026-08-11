/**
 * Author: qingwa
 * Description: observe 名字里的 CSS 类噪声 —— 只重述 role 或带生成 id 的名字不如不给。
 *
 * 真实使用数据(2026-08-11,最近 30 天 138 次 observe / 6585 条元素行):527 条(8.0%)
 * 的名字长得像 CSS 类名。最大的几族:
 *   group|checkbox-group ×65、radiogroup|radio-group ×35、button|chakra-button ×27、
 *   paragraph|chakra-text ×24、button|shrink-0 ×28、list|common_251604984266 …
 * 前四族的共同点是**名字只是把 role 又说了一遍**,对调用方零信息;`common_<数字串>`
 * 这类还会随渲染变化,按名定位必然失效——比无名更糟。
 *
 * 保留判据同样重要:`icon-search` / `closeIcon` / `chevron-down` / `arrow-left` 是
 * 纯图标按钮唯一的名字来源,误杀它们等于把可点元素变成无名(见 2026-06-22 dogfood)。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isNoisyClassName, shouldDropClassName, isTailwindUtilityClass } from "../src/handlers/observe.js";

describe("isNoisyClassName — 只重述 role 的名字", () => {
  it.each([
    ["chakra-button", "button"],
    ["lake-sheet-button", "button"],
    ["bn-agent-btn", "button"],
    ["checkbox-group", "group"],
    ["el-checkbox-group", "group"],
    ["radio-group", "radiogroup"],
    ["chakra-text", "paragraph"],
    ["chakra-link", "link"],
    ["nav-list", "list"],
    ["div", "div"],
  ])("%s @ role=%s 判为噪声", (name, role) => {
    expect(isNoisyClassName(name, role)).toBe(true);
  });

  it.each([
    ["icon-search", "button"],
    ["closeIcon", "button"],
    ["chevron-down", "link"],
    ["arrow-left", "button"],
    ["搜索", "button"],
    ["提交订单", "button"],
    ["applet-left-nav-bottom-user", "div"],
    ["imt-fb-round-button", "div"],
    ["Save changes", "button"],
  ])("%s @ role=%s 必须保留", (name, role) => {
    expect(isNoisyClassName(name, role)).toBe(false);
  });

  it("含空格的真实文案永不判噪声（哪怕撞上 role 词）", () => {
    expect(isNoisyClassName("Group 3", "group")).toBe(false);
    expect(isNoisyClassName("下一步 button", "button")).toBe(false);
  });

  it("空名不判噪声（无名有自己的处理路径）", () => {
    expect(isNoisyClassName("", "button")).toBe(false);
    expect(isNoisyClassName("   ", "button")).toBe(false);
  });
});

describe("isNoisyClassName — 生成 id", () => {
  it.each(["common_251604984266", "common_125", "item-4821", "banniu_20260811"])(
    "%s 判为噪声（随渲染变化，按名定位必失效）",
    (name) => {
      expect(isNoisyClassName(name, "div")).toBe(true);
    },
  );

  it("短数字后缀不误杀（h2 / step2 / 第 1 页 是有意义的）", () => {
    expect(isNoisyClassName("step2", "div")).toBe(false);
    expect(isNoisyClassName("tab-1", "div")).toBe(false);
    expect(isNoisyClassName("第 2 页", "link")).toBe(false);
  });

  // 数据回放实测:班牛商品表的 商品ID / SKUID 就是裸数字串,当成生成 id 会把
  // 整列真实内容抹掉(655 条命中里有约 200 条是这个)
  it.each(["2701848615027053753", "971422439920", "125"])(
    "裸数字串 %s 是内容不是类名，必须保留",
    (name) => {
      expect(isNoisyClassName(name, "td")).toBe(false);
    },
  );
});

describe("shouldDropClassName — 名字出现在可见文本里就不是类名", () => {
  it("类噪声且不在文本中 → 丢", () => {
    expect(shouldDropClassName("chakra-button", "button", "")).toBe(true);
    expect(shouldDropClassName("checkbox-group", "group", "甲 乙")).toBe(true);
  });

  it("同样的字符串若确实是可见文本 → 留（内容优先于启发式）", () => {
    expect(shouldDropClassName("chakra-button", "button", "chakra-button")).toBe(false);
    expect(shouldDropClassName("sku-12345678", "div", "订单 sku-12345678 已发货")).toBe(false);
  });

  it("本来就不是类噪声的名字不受影响", () => {
    expect(shouldDropClassName("icon-search", "button", "")).toBe(false);
  });
});

describe("isTailwindUtilityClass — 补 <关键字>-<数值> 漏网", () => {
  it.each(["shrink-0", "grow-0", "border-0", "rounded-none", "rounded-full", "grow-[2]"])(
    "%s 判为工具类",
    (t) => {
      expect(isTailwindUtilityClass(t)).toBe(true);
    },
  );

  it("原有判据不回归", () => {
    expect(isTailwindUtilityClass("mb-4")).toBe(true);
    expect(isTailwindUtilityClass("hover:opacity-75")).toBe(true);
    expect(isTailwindUtilityClass("block")).toBe(true);
    expect(isTailwindUtilityClass("icon-search")).toBe(false);
    expect(isTailwindUtilityClass("close")).toBe(false);
  });

  it("语义类不因新规则被误杀", () => {
    // `-0`/`-none` 只在关键字集成员后才算工具类
    expect(isTailwindUtilityClass("step-0")).toBe(false);
    expect(isTailwindUtilityClass("badge-none")).toBe(false);
  });
});

describe("inject func 内联副本接入(源码锁,改一处须同步)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );

  it("导出真源与 inject 内联各有一份 isNoisyClassName", () => {
    const exported = (SRC.match(/export function isNoisyClassName\(/g) || []).length;
    const inlined = (SRC.match(/const isNoisyClassName = \(name: string, role: string\): boolean =>/g) || []).length;
    expect(exported).toBe(1);
    expect(inlined).toBe(1);
  });

  it("两份都带生成 id 判据(≥3 位纯数字段)", () => {
    const count = (SRC.match(/\/\^\\d\{3,\}\$\//g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("两份都带关键字带值后缀判据(shrink-0 一类)", () => {
    const count = (SRC.match(/TW_VALUE_SUFFIX_RE/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4); // 每份 1 处定义 + 1 处使用
  });

  it("置空发生在 elements.push,而不是 getAccessibleName 内(否则召回下降)", () => {
    expect(SRC).toMatch(/name: shouldDropClassName\(name, role, visibleTextContent\(htmlEl\)\) \? "" : name,/);
  });

  it("导出真源与 inject 内联各有一份内容优先闸", () => {
    expect((SRC.match(/export function shouldDropClassName\(/g) || []).length).toBe(1);
    expect(
      (SRC.match(/const shouldDropClassName = \(name: string, role: string, visibleText: string\)/g) || []).length,
    ).toBe(1);
  });
});

describe("className 兜底的结构词否决(源码锁)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );
  const DENY = SRC.match(/const ICON_CLASS_DENY_NAMES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";

  // 否决一个 token 会级联到下一个,实测 `class="shrink-0 box"` 名字落到 box
  it.each(["box", "inner", "outer", "content", "body", "root", "item", "wrapper", "container"])(
    "%s 在 denylist 里",
    (w) => {
      expect(DENY).toContain(`"${w}"`);
    },
  );

  it("denylist 非空且确实解析到了（正则失效会让上面全部假绿）", () => {
    expect(DENY.length).toBeGreaterThan(40);
  });
});
