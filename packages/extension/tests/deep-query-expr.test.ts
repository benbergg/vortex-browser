// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { deepQuerySelectorAllExpr } from "../src/lib/deep-query-expr.js";
import { styleProbeFunc } from "../src/handlers/query.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

/** 表达式在页面上下文里求值,与 CDP Runtime.evaluate 拿到的是同一份东西 */
const run = (expr: string): Element[] => eval(expr) as Element[];

describe("deepQuerySelectorAllExpr ↔ styleProbeFunc 集合对齐", () => {
  it("纯 light DOM:两侧数量一致", () => {
    for (let i = 0; i < 4; i++) {
      const d = document.createElement("div");
      d.className = "t";
      document.body.appendChild(d);
    }
    const probe = styleProbeFunc(".t", 50, []) as any;
    expect(run(deepQuerySelectorAllExpr(".t"))).toHaveLength(probe.total);
  });

  it("元素藏在 open shadow 里:表达式也要穿进去,否则 CDP 侧会少一个导致索引错位", () => {
    const plain = document.createElement("div");
    plain.className = "t";
    document.body.appendChild(plain);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    inner.className = "t";
    sr.appendChild(inner);

    const probe = styleProbeFunc(".t", 50, []) as any;
    expect(probe.total).toBe(2);
    expect(run(deepQuerySelectorAllExpr(".t"))).toHaveLength(2);
  });

  it("嵌套两层 shadow:两侧都要走到底", () => {
    const h1 = document.createElement("div");
    document.body.appendChild(h1);
    const s1 = h1.attachShadow({ mode: "open" });
    const h2 = document.createElement("div");
    s1.appendChild(h2);
    const s2 = h2.attachShadow({ mode: "open" });
    const leaf = document.createElement("span");
    leaf.className = "t";
    s2.appendChild(leaf);

    const probe = styleProbeFunc(".t", 50, []) as any;
    expect(probe.total).toBe(1);
    expect(run(deepQuerySelectorAllExpr(".t"))).toHaveLength(1);
  });

  it("closed shadow:两侧都进不去 → 仍然一致(不一致才是灾难)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "closed" });
    const inner = document.createElement("div");
    inner.className = "t";
    sr.appendChild(inner);

    const probe = styleProbeFunc(".t", 50, []) as any;
    expect(run(deepQuerySelectorAllExpr(".t"))).toHaveLength(probe.total);
  });

  it("深度上限与探针一致:超过 8 层 shadow 两侧同样停住", () => {
    let root: Document | ShadowRoot = document;
    let parent: Node = document.body;
    for (let d = 0; d < 10; d++) {
      const host = document.createElement("div");
      parent.appendChild(host);
      const sr = (host as HTMLElement).attachShadow({ mode: "open" });
      const leaf = document.createElement("i");
      leaf.className = "t";
      sr.appendChild(leaf);
      parent = sr;
      root = sr;
    }
    void root;
    const probe = styleProbeFunc(".t", 50, []) as any;
    expect(run(deepQuerySelectorAllExpr(".t"))).toHaveLength(probe.total);
  });

  it("选择器带引号/反斜杠 → 表达式不被注入破坏", () => {
    const d = document.createElement("div");
    d.setAttribute("data-x", 'a"b');
    document.body.appendChild(d);
    const sel = '[data-x="a\\"b"]';
    expect(run(deepQuerySelectorAllExpr(sel))).toHaveLength(1);
  });

  it("limit 生效且与探针 maxResults 同义", () => {
    for (let i = 0; i < 5; i++) {
      const d = document.createElement("div");
      d.className = "t";
      document.body.appendChild(d);
    }
    expect(run(deepQuerySelectorAllExpr(".t", 2))).toHaveLength(2);
  });
});
