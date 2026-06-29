/**
 * Author: qingwa
 * Description: getRole HTML-AAM 隐式映射单测 + 召回门 passesRoleGate 单测 +
 *   inject 内联副本源码锁。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  getRoleForTest,
  passesRoleGateForTest,
} from "../src/handlers/observe.js";
import { RECALL_ROLES } from "../src/reasoning/aria-taxonomy.js";

function roleOf(html: string, sel: string): string {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const el = dom.window.document.querySelector(sel);
  if (!el) throw new Error(`Selector ${sel} matched no element`);
  return getRoleForTest(el);
}

function gate(html: string, sel: string): boolean {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const el = dom.window.document.querySelector(sel);
  if (!el) throw new Error(`Selector ${sel} matched no element`);
  return passesRoleGateForTest(el);
}

describe("getRole 隐式 HTML-AAM 映射", () => {
  it("原生语义标签映射到 ARIA landmark/structure 角色", () => {
    expect(roleOf("<nav></nav>", "nav")).toBe("navigation");
    expect(roleOf("<fieldset></fieldset>", "fieldset")).toBe("group");
    expect(roleOf("<main></main>", "main")).toBe("main");
    expect(roleOf("<aside></aside>", "aside")).toBe("complementary");
    expect(roleOf("<ul></ul>", "ul")).toBe("list");
    expect(roleOf("<li></li>", "li")).toBe("listitem");
    expect(roleOf(`<section aria-label="x"></section>`, "section")).toBe("region");
  });

  it("显式 role 仍优先于隐式", () => {
    expect(roleOf(`<nav role="tablist"></nav>`, "nav")).toBe("tablist");
  });

  it("section 无可及名称 → 返 tag 而非 region", () => {
    expect(roleOf(`<section></section>`, "section")).toBe("section");
  });

  it("header 顶层 → banner;非顶层 → tag", () => {
    expect(roleOf(`<header></header>`, "header")).toBe("banner");
    expect(roleOf(`<article><header></header></article>`, "header")).toBe("header");
  });

  it("footer 顶层 → contentinfo;非顶层 → tag", () => {
    expect(roleOf(`<footer></footer>`, "footer")).toBe("contentinfo");
    expect(roleOf(`<article><footer></footer></article>`, "footer")).toBe("footer");
  });
});

describe("getRole 隐式映射 inject 内联副本源码锁", () => {
  it("observe.ts inject func 含 HTML-AAM 隐式分支", () => {
    const src = readFileSync(
      "/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts",
      "utf8",
    );
    expect(src.includes('return "navigation"')).toBe(true);
    expect(src.includes('return "main"')).toBe(true);
    expect(src.includes('return "group"')).toBe(true);
  });
});

/**
 * 召回门 passesRoleGate(observe 召回决策的核心改造,Task 4)
 *
 * 原决策:命中枚举 CSS 选择器(如 `[role=tabpanel]`)→ 召回。
 * 新决策:命中 [role] / 原生语义标签 + role ∈ RECALL_ROLES(由 aria-taxonomy.ts 派生)
 *   → 召回。一处真源:真源在 reasoning/aria-taxonomy.ts,observe.ts 内联副本与导出版
 *   passesRoleGateForTest 同步(源码锁守护)。
 */
describe("召回门 passesRoleGate(Task 4 核心)", () => {
  it("装饰角色不召回(presentation/none/generic 是 EXPLICIT_DENY)", () => {
    expect(gate(`<div role="presentation">x</div>`, "div")).toBe(false);
    expect(gate(`<div role="none">x</div>`, "div")).toBe(false);
    expect(gate(`<div role="generic">x</div>`, "div")).toBe(false);
  });

  it("R1–R16 容器角色全部召回(一次性,不再逐个补)", () => {
    for (const r of [
      "tabpanel","progressbar","meter","listbox","menu","region",
      "radiogroup","tablist","toolbar","tree","grid","group",
    ]) {
      expect(gate(`<div role="${r}">x</div>`, "div"), `${r} 应召回`).toBe(true);
    }
  });

  it("显式 widget role 召回", () => {
    expect(gate(`<div role="button">x</div>`, "div")).toBe(true);
    expect(gate(`<div role="textbox">x</div>`, "div")).toBe(true);
  });

  it("原生语义容器经隐式映射召回(getRole HTML-AAM)", () => {
    expect(gate("<fieldset>x</fieldset>", "fieldset")).toBe(true); // → group
    expect(gate("<nav>x</nav>", "nav")).toBe(true);                // → navigation
    expect(gate("<main>x</main>", "main")).toBe(true);             // → main
    expect(gate("<ul><li>x</li></ul>", "ul")).toBe(true);          // → list
    expect(gate("<ul><li>x</li></ul>", "li")).toBe(true);          // → listitem
    expect(gate(`<section aria-label="x">x</section>`, "section")).toBe(true); // → region
  });

  it("passesRoleGateForTest 复用真源 RECALL_ROLES(改一处生效)", () => {
    // 真源 + 派生同步的硬检查:任何 RECALL_ROLES 里的 role 经显式声明都过门
    for (const r of RECALL_ROLES) {
      expect(gate(`<div role="${r}">x</div>`, "div"), `${r} 应召回`).toBe(true);
    }
  });

  it("EXPLICIT_DENY 全集不召回(召回门与 EXPLICIT_DENY 同步)", () => {
    const deny = ["presentation","none","generic"];
    for (const r of deny) {
      expect(gate(`<div role="${r}">x</div>`, "div"), `${r} 不应召回`).toBe(false);
    }
  });
});