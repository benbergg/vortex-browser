/**
 * Author: qingwa
 * Description: swiperjs.com / tiptap.dev dogfood —— observe 把 Tailwind 布局工具类
 *   当图标语义名泄漏的根因修复。
 *
 *   实机白盒锁定:`<a class="mb-4"><img class="size-12" alt=""></a>`(装饰 img 空 alt)、
 *   `<button class="p-0.5"><svg lucide></button>`、`<a class="block">…` 等无 aria-label/
 *   title/alt 的图标元素落到 iconNameFromClass 的 className 兜底,正则
 *   `^_?([a-zA-Z][a-zA-Z0-9_-]{2,})` 把 Tailwind 布局类(mb-4/p-0/block/size-12/
 *   text-grayAlpha-600)当语义名返回 → observe 输出 `link "mb-4"` / `button "p-0"`,
 *   对 agent 是噪声且误导(以为是有意义控件名)。
 *
 *   修复:isTailwindUtilityClass 判据(关键字集 + 前缀正则)在 className 兜底里
 *   continue 跳过工具类 token。真语义图标类(icon-search/close/chevron-down/arrow-left)
 *   不命中,正常保留。
 */
import { describe, it, expect } from "vitest";
import { isTailwindUtilityClass } from "../src/handlers/observe.js";

describe("isTailwindUtilityClass (swiperjs/tiptap dogfood Tailwind 工具类泄漏)", () => {
  it("间距类 m-/p- 系(mb-4 / p-0 / px-3 / mt-2 / -mt-2)→ 工具类", () => {
    for (const t of ["mb-4", "p-0", "px-3", "mt-2", "-mt-2", "py-1", "ms-2", "pe-4"]) {
      expect(isTailwindUtilityClass(t)).toBe(true);
    }
  });

  it("尺寸类 w-/h-/size-/min-max(size-12 / w-full / h-screen / max-w-md)→ 工具类", () => {
    for (const t of ["size-12", "w-full", "h-screen", "w-100", "max-w-md", "min-h-0"]) {
      expect(isTailwindUtilityClass(t)).toBe(true);
    }
  });

  it("显示/定位关键字(block / inline-block / flex / grid / hidden / absolute / sticky)→ 工具类", () => {
    for (const t of ["block", "inline-block", "flex", "grid", "hidden", "absolute", "sticky", "truncate"]) {
      expect(isTailwindUtilityClass(t)).toBe(true);
    }
  });

  it("颜色/层叠/排版前缀(text-grayAlpha-600 / bg-white / border-gray / z-50 / opacity-50)→ 工具类", () => {
    for (const t of ["text-grayalpha-600", "bg-white", "border-gray-200", "z-50", "opacity-50", "gap-2", "leading-6"]) {
      expect(isTailwindUtilityClass(t)).toBe(true);
    }
  });

  it("变体类含冒号(hover:opacity-75 / md:flex / dark:bg-gray-800 / group-hover:block)→ 工具类", () => {
    for (const t of ["hover:opacity-75", "md:flex", "dark:bg-gray-800", "group-hover:block", "focus:ring-2", "sm:hidden"]) {
      expect(isTailwindUtilityClass(t)).toBe(true);
    }
  });

  it("真语义图标类(icon-search / close / chevron-down / arrow-left / search / menu-toggle)→ 非工具类", () => {
    for (const t of ["icon-search", "close", "chevron-down", "arrow-left", "search", "menu-toggle", "play", "closeIcon"]) {
      expect(isTailwindUtilityClass(t)).toBe(false);
    }
  });

  it("不误伤以 m/p 起的真词(menu-2 无数字直跟 / play / media)→ 非工具类", () => {
    // m/p 间距类要求 `-数字`,menu/media/play 不命中。
    expect(isTailwindUtilityClass("menu")).toBe(false);
    expect(isTailwindUtilityClass("media")).toBe(false);
    expect(isTailwindUtilityClass("play")).toBe(false);
  });

  it("大小写无关(MB-4 / Block)", () => {
    expect(isTailwindUtilityClass("MB-4")).toBe(true);
    expect(isTailwindUtilityClass("Block")).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("inject func 内联 isTailwindUtilityClass + iconNameFromClass 接入(源码锁,改一处须同步)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );

  it("inject func 含内联 isTailwindUtilityClass 定义", () => {
    const count = (SRC.match(/const isTailwindUtilityClass = \(token: string\): boolean =>/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("iconNameFromClass className 兜底里 continue 跳过工具类(对原始 token 早检测)", () => {
    expect(SRC).toMatch(/if \(isTailwindUtilityClass\(c\)\) continue;/);
  });

  it("工具类否决在 regex 裁剪之前(原始 token,变体类冒号未丢)", () => {
    const twIdx = SRC.search(/if \(isTailwindUtilityClass\(c\)\) continue;/);
    const regexIdx = SRC.indexOf("const m = c.match(/^_?([a-zA-Z]");
    expect(twIdx).toBeGreaterThan(0);
    expect(regexIdx).toBeGreaterThan(0);
    expect(twIdx).toBeLessThan(regexIdx);
  });

  it("内联与导出版均含变体冒号判定 if (t.includes(\":\")) return true", () => {
    const count = (SRC.match(/if \(t\.includes\(":"\)\) return true/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2); // 导出 1 + inject 内联 1
  });
});
