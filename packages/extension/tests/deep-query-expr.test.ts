// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { FINGERPRINT_ON_ARRAY_FN, PATH_MAX_SEGMENTS, deepQuerySelectorAllExpr, elementFingerprint } from "../src/lib/deep-query-expr.js";
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

describe("elementFingerprint ↔ 注入侧 / CDP 侧三处一致", () => {
  const viaExpr = (els: Element[]): string[] =>
    eval(`(${FINGERPRINT_ON_ARRAY_FN})`).call(els) as string[];

  it("两个同 tag、同文本长度、无 id 的元素身份必须不同(tag+len 会碰撞)", () => {
    document.body.innerHTML = "<div><button>Save</button><button>Next</button></div>";
    const els = Array.from(document.querySelectorAll("button"));
    expect(elementFingerprint(els[0])).not.toBe(elementFingerprint(els[1]));
  });

  it("同一个元素被重排后身份必须变 —— 这正是错位检测要抓的", () => {
    document.body.innerHTML = "<div><button>Save</button><button>Next</button></div>";
    const save = document.querySelectorAll("button")[0];
    const before = elementFingerprint(save);
    save.parentElement!.appendChild(save);
    expect(elementFingerprint(save)).not.toBe(before);
  });

  it("多元素集合上,三处实现逐项一致", () => {
    document.body.innerHTML =
      '<section><p id="a">x</p><p></p><span><i>deep</i></span><p>x</p></section>';
    const els = Array.from(document.querySelectorAll("p, i, span"));
    expect(viaExpr(els)).toEqual(els.map(elementFingerprint));
  });

  it("穿 open shadow 的元素三处一致(路径要经 host 上溯)", () => {
    document.body.innerHTML = "<div></div>";
    const host = document.querySelector("div")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<b>a</b><b>b</b>";
    const els = Array.from(sr.querySelectorAll("b"));
    expect(viaExpr(els)).toEqual(els.map(elementFingerprint));
    expect(elementFingerprint(els[0])).not.toBe(elementFingerprint(els[1]));
  });

  it("空文本、深嵌套也一致", () => {
    document.body.innerHTML = "<div><div><div><em></em></div></div></div>";
    const els = Array.from(document.querySelectorAll("em, div"));
    expect(viaExpr(els)).toEqual(els.map(elementFingerprint));
  });

  it("探针内联的身份与真源一致(改一处漏一处会静默错位)", () => {
    document.body.innerHTML = '<div id="z" class="t">abc</div><span class="t">q</span>';
    const probe = styleProbeFunc(".t", 5, ["font"]) as any;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".t"));
    expect(probe.elements.map((e: { fp: string }) => e.fp)).toEqual(els.map(elementFingerprint));
  });

  it("探针内联在 shadow 下也与真源一致", () => {
    document.body.innerHTML = '<p class="t">a</p><div></div>';
    const sr = document.querySelector("div")!.attachShadow({ mode: "open" });
    const inner = document.createElement("p");
    inner.className = "t";
    sr.appendChild(inner);
    const probe = styleProbeFunc(".t", 5, ["font"]) as any;
    const fps = probe.elements.map((e: { fp: string }) => e.fp);
    expect(new Set(fps).size).toBe(2);
    expect(fps).toContain(elementFingerprint(inner));
  });
});

describe("路径深度上限三处一致", () => {
  it("CDP 表达式里的上限是插值出来的数字,不是标识符(注入后页面里没有这个常量)", () => {
    expect(FINGERPRINT_ON_ARRAY_FN).toContain(`< ${PATH_MAX_SEGMENTS}`);
    expect(FINGERPRINT_ON_ARRAY_FN).not.toContain("PATH_MAX_SEGMENTS");
  });

  it("探针内联的上限与真源同值 —— 一处改了另一处没改,深 DOM 上两侧身份会不同", () => {
    const src = styleProbeFunc.toString();
    expect(src).toContain(`parts.length < ${PATH_MAX_SEGMENTS}`);
  });

  it("超过上限时路径截断到上限段", () => {
    let cur: HTMLElement = document.body;
    for (let i = 0; i < PATH_MAX_SEGMENTS + 10; i++) {
      const d = document.createElement("div");
      cur.appendChild(d);
      cur = d;
    }
    cur.className = "deep";
    expect(elementFingerprint(cur).split(">")).toHaveLength(PATH_MAX_SEGMENTS);
  });
});
