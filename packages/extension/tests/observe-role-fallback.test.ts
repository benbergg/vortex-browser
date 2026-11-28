/**
 * Author: qingwa
 * Description: observe 语义模式**最终标签兜底**(保留清单 + 其余归 generic)单测。
 *
 * 断言一律基于**生产注入函数**的真实执行结果:stubDocumentChrome 的
 * chrome.scripting.executeScript 把序列化后的 inject func 在 jsdom window 里 eval
 * 执行(同 observe-epoch-recovery.test.ts 的做法),断言的是 observe.snapshot 的真实输出。
 * 导出版 getRoleForTest 只作「公共行为旁证」,不替代生产注入函数验证。
 *
 * 缺陷背景(2026-11-28 第6轮 a11y 评测):兜底原为无条件 `return tag`,把
 * <div>/<span>/<body>/<html>/自定义元素(mdn-button / turbo-frame)的标签名当 role 输出,
 * Chrome AX 原始树里根本没有这些 role,a11y 消费者无法按 ARIA 语义推理。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { getRoleForTest, registerObserveHandlers } from "../src/handlers/observe.js";
import { stubDocumentChrome } from "./helpers/document-chrome.js";

/* ------------------------------------------------------------------ *
 * 预期表:独立于实现常量写死(实现与测试不共用同一份清单)。
 * ------------------------------------------------------------------ */

/** 预期保留:标签兜底后 role 仍等于标签名(22 项)。 */
const EXPECTED_KEEP_ROLE_TAGS = [
  "table", "caption", "article", "figure", "blockquote", "form", "search", "dialog",
  "menu", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "meter", "marquee",
  "img", "code", "strong", "time", "math", "link", "switch",
];

/** 兼容例外:label 不是合法 ARIA 角色,只因既有 overlay 启发式依赖它才保留。 */
const EXPECTED_COMPAT_LABEL_ROLE = "label";

/** 预期归 generic:标签名不是角色名(逐项断言)。 */
const EXPECTED_GENERIC_ROLE_TAGS = [
  "progress", "optgroup", "thead", "tbody", "tfoot", "tr", "td", "th", "h1", "h2", "h6",
  "output", "col", "colgroup", "legend", "datalist", "dl", "dt", "dd", "p", "pre", "em",
  "i", "b", "u", "s", "small", "sub", "sup", "mark", "abbr", "dfn", "cite", "q", "kbd",
  "samp", "var", "del", "ins", "address", "hr", "br", "picture", "video", "audio", "canvas",
  "ruby", "rt", "rp", "bdi", "bdo", "slot", "template", "noscript", "svg", "details",
  "div", "span", "body", "html", "mdn-button", "turbo-frame",
];

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** observe 收集循环跳过只读滚动标签(pre/code/samp/kbd),只有 contenteditable 例外才入池。 */
const READONLY_SCROLL_TAGS = ["pre", "code", "samp", "kbd"];

/** 需要特定父容器才有合法结构的标签。 */
const TABLE_SECTION_TAGS = ["caption", "thead", "tbody", "tfoot", "tr", "td", "th", "col", "colgroup"];
const SELECT_TAGS = ["option", "optgroup"];
const FIELD_TAGS = ["legend"];
const DL_TAGS = ["dt", "dd"];
const RUBY_TAGS = ["rt", "rp"];

/* ------------------------------------------------------------------ *
 * fixture 构造
 * ------------------------------------------------------------------ */

function createCaseElement(doc: Document, tag: string): Element {
  if (tag === "switch" || tag === "svg") return doc.createElementNS(SVG_NS, tag);
  if (tag === "math") return doc.createElementNS(MATHML_NS, tag);
  return doc.createElement(tag);
}

/**
 * 把一个「标签兜底」用例挂到页面上。给每个用例元素一个点击信号(onclick)使其入池,
 * 并用 data-testid 唯一标识输出元素。
 */
function mountCase(doc: Document, host: Element, tag: string): Element {
  const el = createCaseElement(doc, tag);
  el.setAttribute("data-testid", `case-${tag}`);
  el.setAttribute("aria-label", `case-${tag}`);
  if (READONLY_SCROLL_TAGS.includes(tag)) el.setAttribute("contenteditable", "true");
  else el.setAttribute("onclick", "void 0");

  if (tag === "body") {
    doc.body.setAttribute("data-testid", "case-body");
    doc.body.setAttribute("aria-label", "case-body");
    doc.body.setAttribute("onclick", "void 0");
    return doc.body;
  }
  if (tag === "html") {
    doc.documentElement.setAttribute("data-testid", "case-html");
    doc.documentElement.setAttribute("aria-label", "case-html");
    doc.documentElement.setAttribute("onclick", "void 0");
    return doc.documentElement;
  }

  const wrapper = doc.createElement("div");
  const wrap = (child: Element) => {
    wrapper.appendChild(child);
    host.appendChild(wrapper);
    return child;
  };

  if (TABLE_SECTION_TAGS.includes(tag)) {
    const table = doc.createElement("table");
    if (tag === "caption") table.appendChild(el);
    else if (tag === "col" || tag === "colgroup") {
      const colgroup = doc.createElement("colgroup");
      colgroup.appendChild(el);
      table.appendChild(colgroup);
    } else {
      const section = doc.createElement(tag === "tr" ? "tbody" : tag);
      if (tag === "tr") {
        const cell = doc.createElement("td");
        cell.textContent = "cell";
        el.appendChild(cell);
      }
      section.appendChild(el);
      table.appendChild(section);
    }
    return wrap(table);
  }
  if (SELECT_TAGS.includes(tag)) {
    const select = doc.createElement("select");
    select.appendChild(el);
    return wrap(select);
  }
  if (FIELD_TAGS.includes(tag)) {
    const fieldset = doc.createElement("fieldset");
    fieldset.appendChild(el);
    return wrap(fieldset);
  }
  if (DL_TAGS.includes(tag)) {
    const dl = doc.createElement("dl");
    dl.appendChild(el);
    return wrap(dl);
  }
  if (RUBY_TAGS.includes(tag)) {
    const ruby = doc.createElement("ruby");
    ruby.appendChild(el);
    return wrap(ruby);
  }
  return wrap(el);
}

/* ------------------------------------------------------------------ *
 * 生产注入函数执行:stubDocumentChrome → chrome.scripting.executeScript
 * → jsdom window.eval(序列化 inject func)
 * ------------------------------------------------------------------ */

async function runObserve(dom: JSDOM, args: Record<string, unknown> = {}): Promise<any[]> {
  const win = dom.window as any;
  for (const name of [
    "window", "document", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element",
    "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location",
  ]) {
    vi.stubGlobal(name, name === "window" ? win : win[name]);
  }
  // jsdom 的 getComputedStyle 不支持 SVG/MathML 元素(抛错),对它们退化成空样式对象,
  // 否则整帧扫描中断、拿不到任何元素。
  const rawGetComputedStyle = win.getComputedStyle.bind(win);
  win.getComputedStyle = (el: any) => {
    try {
      return rawGetComputedStyle(el);
    } catch {
      return new Proxy({}, { get: (_target, prop) => (prop === "getPropertyValue" ? () => "" : "") }) as any;
    }
  };
  vi.stubGlobal("getComputedStyle", win.getComputedStyle);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  win.Element.prototype.getBoundingClientRect = () => ({
    x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50,
  });
  Object.defineProperty(win.document, "elementFromPoint", { value: () => null });
  stubDocumentChrome([{ frameId: 0, parentFrameId: -1, dom }]);
  const router = new ActionRouter();
  // 不接 debugger:AX overlay 不参与,观察到的 role 就是页面侧注入 getRole 的产出。
  registerObserveHandlers(router, undefined as any);
  const response: any = await router.dispatch({
    type: "tool_request",
    tool: "observe.snapshot",
    args: { format: "full", frames: "main", maxElements: 300, ...args },
    requestId: "role-fallback",
    tabId: 42,
  });
  if (response.error) throw new Error(`observe.snapshot failed: ${JSON.stringify(response.error)}`);
  return response.result.elements as any[];
}

function newPage(): { dom: JSDOM; doc: Document } {
  const dom = new JSDOM(`<!doctype html><body><div id="host"></div></body>`, {
    url: "https://example.test/", pretendToBeVisual: true, runScripts: "outside-only",
  });
  return { dom, doc: dom.window.document };
}

function byTestId(elements: any[], testId: string): any {
  const found = elements.filter((el) => el?.attrs?.["data-testid"] === testId);
  if (found.length !== 1) {
    throw new Error(`expected exactly one element with data-testid=${testId}, got ${found.length}`);
  }
  return found[0];
}

/* ------------------------------------------------------------------ *
 * 三个 fixture 页面(observe 各跑一次)
 * ------------------------------------------------------------------ */

let tagElements: any[] = [];
let mappingElements: any[] = [];
let guardElements: any[] = [];
let switchElement: Element | undefined;
const pages: JSDOM[] = [];

beforeAll(async () => {
  // ① 标签兜底用例页
  const tagPage = newPage();
  pages.push(tagPage.dom);
  const host = tagPage.doc.getElementById("host")!;
  for (const tag of [...EXPECTED_KEEP_ROLE_TAGS, "label", ...EXPECTED_GENERIC_ROLE_TAGS]) {
    const el = mountCase(tagPage.doc, host, tag);
    if (tag === "switch") switchElement = el;
  }
  tagElements = await runObserve(tagPage.dom);

  // ② 显式 role / 原生隐式映射 / bnCheck 启发式
  const mapPage = newPage();
  pages.push(mapPage.dom);
  mapPage.doc.getElementById("host")!.innerHTML = `
    <div role="button" data-testid="explicit-button" aria-label="Explicit button">E</div>
    <nav role="tablist" data-testid="explicit-tablist" aria-label="Explicit tablist">N</nav>
    <a href="#anchor" data-testid="implicit-link">A</a>
    <button data-testid="implicit-button">B</button>
    <nav data-testid="implicit-nav">N</nav>
    <ul data-testid="implicit-list"><li data-testid="implicit-listitem">L</li></ul>
    <section aria-label="Named section" data-testid="implicit-region">S</section>
    <div class="bnCheck" onclick="void 0" aria-label="BnCheck" data-testid="heuristic-checkbox">
      <span class="bnCheck-status"></span>
    </div>`;
  mappingElements = await runObserve(mapPage.dom);

  // ③ 护栏:无点击信号的原生 table + 原生交互元素
  const guardPage = newPage();
  pages.push(guardPage.dom);
  guardPage.doc.getElementById("host")!.innerHTML = `
    <table data-testid="guard-table" aria-label="Guard table"><tbody><tr><td>cell</td></tr></tbody></table>
    <a href="#anchor" data-testid="guard-link">L</a>
    <button data-testid="guard-button">B</button>
    <input data-testid="guard-input" aria-label="I" />
    <select data-testid="guard-select" aria-label="S"><option>o</option></select>
    <textarea data-testid="guard-textarea" aria-label="T"></textarea>`;
  guardElements = await runObserve(guardPage.dom);
});

afterAll(() => {
  for (const page of pages) page.window.close();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

describe("observe 标签兜底:保留清单(生产注入函数路径)", () => {
  it.each(EXPECTED_KEEP_ROLE_TAGS)("keeps <%s> role as the tag name", (tag) => {
    expect(byTestId(tagElements, `case-${tag}`).role).toBe(tag);
  });

  it("keeps <label> as the compatibility exception", () => {
    expect(byTestId(tagElements, "case-label").role).toBe(EXPECTED_COMPAT_LABEL_ROLE);
  });

  it("builds the <switch> case in the SVG namespace", () => {
    expect(switchElement?.namespaceURI).toBe(SVG_NS);
    expect(byTestId(tagElements, "case-switch").role).toBe("switch");
  });
});

describe("observe 标签兜底:清单外归 generic(生产注入函数路径)", () => {
  it.each(EXPECTED_GENERIC_ROLE_TAGS)("maps <%s> to generic", (tag) => {
    expect(byTestId(tagElements, `case-${tag}`).role).toBe("generic");
  });
});

describe("observe 标签兜底:显式 role / 原生隐式映射 / 启发式不变", () => {
  it("keeps the explicit role ahead of every implicit mapping", () => {
    expect(byTestId(mappingElements, "explicit-button").role).toBe("button");
    expect(byTestId(mappingElements, "explicit-tablist").role).toBe("tablist");
  });

  it("keeps the native HTML-AAM implicit mapping", () => {
    expect(byTestId(mappingElements, "implicit-link").role).toBe("link");
    expect(byTestId(mappingElements, "implicit-button").role).toBe("button");
    expect(byTestId(mappingElements, "implicit-nav").role).toBe("navigation");
    expect(byTestId(mappingElements, "implicit-list").role).toBe("list");
    expect(byTestId(mappingElements, "implicit-listitem").role).toBe("listitem");
    expect(byTestId(mappingElements, "implicit-region").role).toBe("region");
  });

  it("keeps the bnCheck heuristic on checkbox", () => {
    expect(byTestId(mappingElements, "heuristic-checkbox").role).toBe("checkbox");
  });
});

describe("observe 标签兜底:护栏", () => {
  it("A: keeps a native <table> without any click signal in the pool", () => {
    // generic 不在 RECALL_ROLES 内,兜底若把 table 改名,它会被召回门过滤掉(整表消失)。
    const table = byTestId(guardElements, "guard-table");
    expect(table.role).toBe("table");
  });

  it("B: keeps native interactive elements in the pool with unchanged roles", () => {
    expect(byTestId(guardElements, "guard-link").role).toBe("link");
    expect(byTestId(guardElements, "guard-button").role).toBe("button");
    expect(byTestId(guardElements, "guard-input").role).toBe("textbox");
    expect(byTestId(guardElements, "guard-select").role).toBe("combobox");
    expect(byTestId(guardElements, "guard-textarea").role).toBe("textbox");
  });
});

describe("getRoleForTest 导出版:公共行为旁证", () => {
  const dom = new JSDOM(`<!doctype html><body></body>`);

  it.each(EXPECTED_KEEP_ROLE_TAGS)("keeps <%s> role as the tag name", (tag) => {
    expect(getRoleForTest(dom.window.document.createElement(tag))).toBe(tag);
  });

  it("keeps <label> as the compatibility exception", () => {
    expect(getRoleForTest(dom.window.document.createElement("label"))).toBe(EXPECTED_COMPAT_LABEL_ROLE);
  });

  it.each(EXPECTED_GENERIC_ROLE_TAGS)("maps <%s> to generic", (tag) => {
    expect(getRoleForTest(dom.window.document.createElement(tag))).toBe("generic");
  });
});
