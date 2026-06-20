// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { partitionMainContentFirst, isNavMenuRoot } from "../src/handlers/observe.js";

/**
 * main-content-priority(A-1):文档站「左导航 + 右主内容」布局下,导航(DOM 序在前)
 * 霸占 maxElements 配额、主内容 0 召回(semi.design Select dogfood 实证)。
 * 双信号:① 语义 <main>/[role=main] 内容区元素前置;② 多数文档站无语义 <main>
 * (semi.design 用 <div id=main-content>),退而把 <nav>/[role=navigation] 导航区降权。
 * 二者都把长导航挤出截断前缀。本测直测模块导出 + source-lock 内联副本。
 */
describe("main-content-priority (A-1)", () => {
  describe("partitionMainContentFirst(内容前置 + 导航降权)", () => {
    it("无 main、无 nav → 返回原数组(同引用,零漂移)", () => {
      document.body.innerHTML = `<div><a id="a"></a><button id="b"></button></div>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [get("a"), get("b")];
      expect(partitionMainContentFirst(cands, null)).toBe(cands);
    });

    it("有 <main>:内容元素前置,导航保持原序", () => {
      document.body.innerHTML =
        `<nav><a id="n0"></a><a id="n1"></a></nav>` +
        `<main id="m"><button id="demo0"></button><button id="demo1"></button></main>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [get("n0"), get("n1"), get("demo0"), get("demo1")];
      const out = partitionMainContentFirst(cands, get("m"));
      expect(out.map((e) => e.id)).toEqual(["demo0", "demo1", "n0", "n1"]);
    });

    it("无语义 <main> 但有 <nav>(semi.design 场景)→ 导航降权,内容前移", () => {
      // semi.design:内容在 <div id=main-content> 而非 <main>,侧栏是 <nav>
      document.body.innerHTML =
        `<div id="main-content">` +
        `<nav><a id="n0"></a><a id="n1"></a><a id="n2"></a></nav>` +
        `<button id="demo"></button>` +
        `</div>`;
      const get = (id: string) => document.getElementById(id)!;
      // DOM 序:导航在前、demo 在后(被截断的处境);mainEl=null(无语义 main)
      const cands = [get("n0"), get("n1"), get("n2"), get("demo")];
      const out = partitionMainContentFirst(cands, null);
      expect(out.map((e) => e.id)).toEqual(["demo", "n0", "n1", "n2"]);
    });

    it("[role=navigation] 同样被降权", () => {
      document.body.innerHTML =
        `<div role="navigation"><a id="n0"></a></div><button id="demo"></button>`;
      const get = (id: string) => document.getElementById(id)!;
      const out = partitionMainContentFirst([get("n0"), get("demo")], null);
      expect(out.map((e) => e.id)).toEqual(["demo", "n0"]);
    });

    it("候选全在 nav 内(无 main)→ 原数组同序(零漂移)", () => {
      document.body.innerHTML = `<nav><a id="a"></a><a id="b"></a></nav>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [get("a"), get("b")];
      expect(partitionMainContentFirst(cands, null)).toBe(cands);
    });

    it("有 <main> 且 nav 在 main 外 → 内容前置(nav 降权一致)", () => {
      document.body.innerHTML =
        `<a id="nav"></a><div id="m" role="main"><button id="c"></button></div>`;
      const get = (id: string) => document.getElementById(id)!;
      const out = partitionMainContentFirst([get("nav"), get("c")], get("m"));
      expect(out.map((e) => e.id)).toEqual(["c", "nav"]);
    });

    it("ant.design 场景:<main> 内嵌跨页链接 role=menu 侧栏 → 侧栏降权、demo 前移", () => {
      // ant.design:侧栏 ant-menu-inline(role=menu)在 <main> 内、position static、
      // 无 fixed 祖先,故不走 overlay 也不被 isNav(非 nav landmark)捕获,DOM 序前于
      // demo,74 项菜单霸占 maxElements。判据=跨页 <a href> 链接占多数 → 降权。
      const links = Array.from({ length: 6 }, (_, i) =>
        `<li role="menuitem"><a id="s${i}" href="/components/c${i}">C${i}</a></li>`,
      ).join("");
      document.body.innerHTML =
        `<main id="m">` +
        `<ul role="menu" id="side">${links}</ul>` +
        `<select id="demo0"></select><input id="demo1">` +
        `</main>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [
        get("s0"), get("s1"), get("s2"), get("s3"), get("s4"), get("s5"),
        get("demo0"), get("demo1"),
      ];
      const out = partitionMainContentFirst(cands, get("m"));
      // demo 应排在 6 个侧栏链接之前
      expect(out.map((e) => e.id)).toEqual([
        "demo0", "demo1", "s0", "s1", "s2", "s3", "s4", "s5",
      ]);
    });
  });

  describe("isNavMenuRoot(导航菜单根识别)", () => {
    it("nav landmark 内的 role=menu → true", () => {
      document.body.innerHTML = `<nav><ul role="menu" id="m"></ul></nav>`;
      expect(isNavMenuRoot(document.getElementById("m")!, "menu")).toBe(true);
    });
    it("跨页链接占多数的 role=menu(无 nav 祖先,ant.design 侧栏)→ true", () => {
      const links = Array.from({ length: 6 }, (_, i) =>
        `<li role="menuitem"><a href="/components/c${i}">C${i}</a></li>`,
      ).join("");
      document.body.innerHTML = `<ul role="menu" id="m">${links}</ul>`;
      expect(isNavMenuRoot(document.getElementById("m")!, "menu")).toBe(true);
    });
    it("被演示的 Menu 组件(项无跨页链接)→ false(不误降内容区)", () => {
      const items = Array.from({ length: 6 }, (_, i) =>
        `<li role="menuitem">Item ${i}</li>`,
      ).join("");
      document.body.innerHTML = `<ul role="menu" id="m">${items}</ul>`;
      expect(isNavMenuRoot(document.getElementById("m")!, "menu")).toBe(false);
    });
    it("锚点(#)链接不算跨页 → false", () => {
      const items = Array.from({ length: 6 }, (_, i) =>
        `<li role="menuitem"><a href="#sec${i}">S${i}</a></li>`,
      ).join("");
      document.body.innerHTML = `<ul role="menu" id="m">${items}</ul>`;
      expect(isNavMenuRoot(document.getElementById("m")!, "menu")).toBe(false);
    });
    it("项数 <5 → false(小菜单不当导航)", () => {
      document.body.innerHTML =
        `<ul role="menu" id="m">` +
        `<li role="menuitem"><a href="/a">A</a></li>` +
        `<li role="menuitem"><a href="/b">B</a></li>` +
        `</ul>`;
      expect(isNavMenuRoot(document.getElementById("m")!, "menu")).toBe(false);
    });
    it("role 非 menu/tree → false", () => {
      document.body.innerHTML = `<nav><ul role="listbox" id="m"></ul></nav>`;
      expect(isNavMenuRoot(document.getElementById("m")!, "listbox")).toBe(false);
    });
  });

  describe("inject func 内联副本 drift 锁(改一处须同步)", () => {
    const SRC = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
      "utf8",
    );
    it("内联无浮层分支含 <main>/[role=main]/#main-content 内容区探测", () => {
      expect(SRC).toContain('document.querySelector("main")');
      expect(SRC).toContain('[role="main"]');
      // semi.design 等多数文档站无语义 <main>,靠 #main-content(skip-link 标准目标)兜底
      expect(SRC).toContain('document.querySelector("#main-content")');
    });
    it("内联含导航区降权(nav/[role=navigation] closest)", () => {
      expect(SRC).toContain('nav,[role="navigation"],[role="menubar"]');
      expect(SRC).toMatch(/isNavA1\(el\)/);
    });
    it("内联含导航菜单根降权(inNavMenu / isNavMenuRoot,ant.design 侧栏)", () => {
      expect(SRC).toMatch(/inNavMenu\(el\)/);
      expect(SRC).toContain('[role="menuitem"],[role="treeitem"]');
    });
  });
});
