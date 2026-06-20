// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { partitionMainContentFirst } from "../src/handlers/observe.js";

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
  });
});
