// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { partitionMainContentFirst } from "../src/handlers/observe.js";

/**
 * main-content-priority(A-1):文档站「左导航 + 右主内容」布局下,导航(DOM 序在前)
 * 霸占 maxElements 配额、主内容 0 召回(semi.design Select dogfood 实证)。用 WAI-ARIA
 * landmark <main>/[role=main] 把内容区候选前置。本测直测模块导出 + source-lock 内联副本。
 */
describe("main-content-priority (A-1)", () => {
  describe("partitionMainContentFirst(主内容前置 + 零漂移)", () => {
    it("无 main(mainEl=null)→ 返回原数组(同引用,baseline 零漂移)", () => {
      const cands = [document.createElement("a"), document.createElement("button")];
      expect(partitionMainContentFirst(cands, null)).toBe(cands);
    });

    it("主内容候选前置,导航保持原序(154 nav 挤光 demo 的修复)", () => {
      document.body.innerHTML =
        `<nav><a id="n0"></a><a id="n1"></a></nav>` +
        `<main id="m"><button id="demo0"></button><button id="demo1"></button></main>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [get("n0"), get("n1"), get("demo0"), get("demo1")];
      const out = partitionMainContentFirst(cands, get("m"));
      expect(out.map((e) => e.id)).toEqual(["demo0", "demo1", "n0", "n1"]);
    });

    it("[role=main] 同样生效", () => {
      document.body.innerHTML =
        `<a id="nav"></a><div id="m" role="main"><button id="c"></button></div>`;
      const get = (id: string) => document.getElementById(id)!;
      const out = partitionMainContentFirst([get("nav"), get("c")], get("m"));
      expect(out.map((e) => e.id)).toEqual(["c", "nav"]);
    });

    it("候选全在 main 内 → 原数组同序(零漂移)", () => {
      document.body.innerHTML = `<main id="m"><a id="a"></a><a id="b"></a></main>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [get("a"), get("b")];
      expect(partitionMainContentFirst(cands, get("m"))).toBe(cands);
    });

    it("候选全不在 main 内 → 原数组同序(零漂移)", () => {
      document.body.innerHTML = `<main id="m"></main><a id="a"></a><a id="b"></a>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [get("a"), get("b")];
      expect(partitionMainContentFirst(cands, get("m"))).toBe(cands);
    });
  });

  describe("inject func 内联副本 drift 锁(改一处须同步)", () => {
    const SRC = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
      "utf8",
    );
    it("内联无浮层分支含 <main>/[role=main] landmark 探测", () => {
      expect(SRC).toContain('document.querySelector("main")');
      expect(SRC).toContain('[role="main"]');
    });
    it("内联含 main 成员分区逻辑(mainEl.contains 前置)", () => {
      expect(SRC).toMatch(/mainEl\.contains\(el\)\s*\?\s*inMain\s*:\s*outMain/);
    });
  });
});
