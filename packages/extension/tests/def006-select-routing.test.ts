import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMIT_DRIVERS, findDriver } from "../src/patterns/commit-drivers.js";

/**
 * 回归锁:DEF-006 —— kind="select" 不再独占绑定 Element Plus。
 *
 * 根因:`findDriver("select")` 1:1 固定映射到 element-plus-select(closestSelector
 * ".el-select"),非 EP 的 select-like 控件(Headless UI / MUI / Radix / antd /
 * react-select 等 ARIA combobox/listbox)在代理直觉性 kind="select" 下 100% 返回
 * UNSUPPORTED_TARGET,必须改用 kind="aria-select" 才能命中(V1 DEF-002 同源)。
 *
 * 修复:kind="select" 升级为「select-like 控件」统一入口。COMMIT handler 同时加载
 * EP 专用 driver 与通用 ARIA driver,page-side 按要素结构二段路由:
 *   target 落在/含 .el-select  → __vortexCommitSelect(EP 专属 filterable 等交互)
 *   原生 <select>             → UNSUPPORTED_TARGET + 指引 action "select"
 *   其余 combobox/listbox     → __vortexCommitAriaSelect(通用 ARIA)
 *
 * 后向兼容:driver 注册表与 COMMIT_KINDS 不变(kind="aria-select" 保留作显式入口),
 * 仅 dom.ts 路由层与 kind="select" 的 page-side 分派语义扩展。
 * page-side 注入 func 不可 import → source-grep 守护 + 真站 live(headlessui iframe)。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");

// 抽出 COMMIT handler 内 kind="select" 的 page-side 注入 func 文本(driverId
// === "element-plus-select" 分支),便于针对路由逻辑做更聚焦的断言。
const COMMIT_BLOCK = DOM_SRC.slice(
  DOM_SRC.indexOf('driverId === "element-plus-select"'),
);

describe("DEF-006 注册表保持不变(后向兼容)", () => {
  it("findDriver('select') 仍是 element-plus-select", () => {
    expect(findDriver("select")?.id).toBe("element-plus-select");
    expect(findDriver("select")?.closestSelector).toBe(".el-select");
  });
  it("findDriver('aria-select') 仍是 generic-aria-select", () => {
    expect(findDriver("aria-select")?.id).toBe("generic-aria-select");
  });
  it("两个 driver 都在注册表中", () => {
    const ids = COMMIT_DRIVERS.map((d) => d.id);
    expect(ids).toContain("element-plus-select");
    expect(ids).toContain("generic-aria-select");
  });
});

describe("DEF-006 COMMIT handler 为 kind=select 同时加载两个 page-side 模块", () => {
  it("kind=select 分支加载 commit-select", () => {
    expect(DOM_SRC).toMatch(
      /driver\.kind === "select"[\s\S]{0,800}"commit-select"/,
    );
  });
  it("kind=select 分支也加载 commit-aria-select(回退用)", () => {
    expect(DOM_SRC).toMatch(
      /driver\.kind === "select"[\s\S]{0,800}"commit-aria-select"/,
    );
  });
});

describe("DEF-006 page-side 二段路由逻辑", () => {
  it("element-plus-select 分支先判定 .el-select(closest 或 querySelector)", () => {
    expect(COMMIT_BLOCK).toMatch(
      /target\.closest\(closestSelector\)\s*\|\|\s*target\.querySelector\(closestSelector\)/,
    );
  });
  it("命中 el-select 走 __vortexCommitSelect", () => {
    expect(COMMIT_BLOCK).toMatch(/__vortexCommitSelect\.run/);
  });
  it("未命中 el-select 且非原生 select 时回退 __vortexCommitAriaSelect", () => {
    // aria 回退发生在 element-plus-select 分支末尾(EP 与 native 判定之后)
    expect(COMMIT_BLOCK).toMatch(/__vortexCommitAriaSelect\.run\(sel, ariaClosest/);
  });
  it("原生 <select> 明确指引 action select,不静默回退", () => {
    expect(COMMIT_BLOCK).toMatch(/tagName === "SELECT"/);
    expect(COMMIT_BLOCK).toMatch(/native <select>/);
    expect(COMMIT_BLOCK).toMatch(/nativeSelect: true/);
  });
  it("element-plus-select 分支自带 ELEMENT_NOT_FOUND / SELECTOR_AMBIGUOUS 守卫", () => {
    expect(COMMIT_BLOCK).toMatch(/ELEMENT_NOT_FOUND/);
    expect(COMMIT_BLOCK).toMatch(/SELECTOR_AMBIGUOUS/);
  });
});

describe("DEF-006 注入参数携带 aria closestSelector", () => {
  it("host 侧计算 generic-aria-select 的 closestSelector 传入", () => {
    expect(DOM_SRC).toMatch(/ariaClosestSelector\s*=\s*[\s\S]{0,120}findDriver\("aria-select"\)\?\.closestSelector/);
  });
  it("nativePageQuery 实参含 ariaClosestSelector", () => {
    expect(DOM_SRC).toMatch(/\[selector, driver\.closestSelector, ariaClosestSelector,/);
  });
  it("注入 func 形参含 ariaClosest", () => {
    expect(DOM_SRC).toMatch(/ariaClosest: string,/);
  });
});

describe("DEF-006 page-side func 注入安全(无模块级 helper 引用)", () => {
  it("driver 调用经 window 取得,不引用模块作用域符号", () => {
    // 注入后模块作用域剥离,只能经 window/document/形参访问(page-side func 内联陷阱)。
    // `const w = window as any` 在注入 func 顶部(checkbox-group 分支之前),不在
    // element-plus-select 分支切片内,故对 DOM_SRC 全文断言。
    expect(DOM_SRC).toMatch(/const w = window as any/);
    expect(COMMIT_BLOCK).toMatch(/w\.__vortexCommitSelect/);
    expect(COMMIT_BLOCK).toMatch(/w\.__vortexCommitAriaSelect/);
  });
});
