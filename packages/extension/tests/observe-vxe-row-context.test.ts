// VXE 3.25.16: table/src/body.ts renders rowid on each body fragment;
// methods.ts getTableData().fullData and getRowid(row) expose the complete flat
// data and encoded key. getRowById uses a key cache and cannot prove uniqueness.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";

import { stubDocumentChrome } from "./helpers/document-chrome.js";

type Row = { id: string; privateValue: string };
type Table = {
  $options: { name: string }; $parent: null; treeConfig: null;
  getTableData?: () => { fullData: Row[]; visibleData: Row[]; tableData: Row[]; footerData: never[] };
  getRowid?: (row: Row) => string;
  getRowById: (id: string) => Row | null;
};

function table(rows: Row[]): Table {
  return {
    $options: { name: "VxeTable" }, $parent: null, treeConfig: null,
    getTableData: () => ({ fullData: rows.slice(), visibleData: rows.slice(), tableData: rows.slice(), footerData: [] }),
    getRowid: (row) => encodeURIComponent(row.id),
    // The upstream cache retains only one of the entries when keys collide.
    getRowById: (id) => rows.findLast((row) => row.id === id) ?? null,
  };
}

function fragment(side: string, rows: Array<{ id: string; content: string }>): string {
  const wrapper = side === "main" ? "body--wrapper" : `fixed-${side}--wrapper`;
  return `<div class="vxe-table--body-wrapper ${wrapper}" data-side="${side}"><table><tbody>${rows.map((r) =>
    `<tr class="vxe-body--row" rowid="${encodeURIComponent(r.id)}"><td>${r.content}</td></tr>`,
  ).join("")}</tbody></table></div>`;
}

function mount(dom: JSDOM, component: Table | null, html: string): HTMLElement {
  const host = dom.window.document.createElement("div");
  host.className = "vxe-table";
  host.innerHTML = html;
  if (component) (host as any).__vue__ = component;
  dom.window.document.body.appendChild(host);
  return host;
}

function newDom(): JSDOM {
  return new JSDOM("<!doctype html><html><body></body></html>", { url: "https://x/", pretendToBeVisual: true, runScripts: "outside-only" });
}

function installDom(dom: JSDOM) {
  const win = dom.window as any;
  for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement", "Element", "Node", "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment", "location"]) {
    vi.stubGlobal(name, name === "window" ? win : win[name]);
  }
  vi.stubGlobal("getComputedStyle", win.getComputedStyle.bind(win));
  vi.stubGlobal("CSS", { escape: (v: string) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
  // jsdom has no layout; specify geometry for visible and clipped text separately.
  win.Element.prototype.getBoundingClientRect = function () {
    // 显式盒子 l,t,r,b:用来构造"滚动容器比内容窄""盒子被外层裁掉"等真实布局。
    const box = this.getAttribute?.("data-box");
    if (box) {
      const [l, t, r, b] = box.split(",").map(Number);
      return { x: l, y: t, width: r - l, height: b - t, top: t, left: l, right: r, bottom: b };
    }
    const clipped = this.parentElement?.closest("[data-clipped]");
    return clipped
      ? { x: 1000, y: 20, width: 80, height: 30, top: 20, left: 1000, right: 1080, bottom: 50 }
      : { x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 };
  };
  Object.defineProperty(win.document, "elementFromPoint", { configurable: true, value: () => null });
}

async function snapshot(doms: Record<number, JSDOM>, args: Record<string, unknown> = {}) {
  const frames = Object.keys(doms).map(Number).map((id) => ({ frameId: id, parentFrameId: id ? 0 : -1, url: id ? "https://x/child" : "https://x/" }));
  for (const frame of frames) {
    doms[frame.frameId].reconfigure({ url: frame.url });
    installDom(doms[frame.frameId]);
  }
  stubDocumentChrome(frames.map((frame) => ({ ...frame, dom: doms[frame.frameId] })));
  const router = new ActionRouter();
  registerObserveHandlers(router);
  const response = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args, requestId: "row-context", tabId: 42 } as NmRequest);
  expect(response.error).toBeUndefined();
  return response.result as { elements: Array<{ name: string; tag: string; frameId: number; dupContext?: string }> };
}

const entries = (ids: string[]): Row[] => ids.map((id) => ({ id, privateValue: `PRIVATE-${id}` }));
const buttons = (result: Awaited<ReturnType<typeof snapshot>>) => result.elements.filter((e) => e.tag === "button" && e.name === "详情");
const action = (id: string) => `<button id="${id}">详情</button>`;
const unavailable = "[row-context-unavailable]";

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("observe.snapshot VXE logical row context", () => {
  it("joins Vue 3 production vnode table fragments with unique keys", async () => {
    const dom = newDom();
    const host = mount(dom, null,
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const app = dom.window.document.createElement("div");
    host.before(app);
    app.appendChild(host);
    // Vue 3 production: app._instance is null; the mounted vnode owns the component subtree.
    (app as any).__vue_app__ = { _instance: null };
    (app as any)._vnode = { component: { subTree: { children: [{
      el: host, component: { type: { name: "VxeTable" }, proxy: table(entries(["K", "L"])), subTree: { el: host } },
    }] } } };
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toContain("订单甲");
    expect(found[1].dupContext).toContain("订单乙");
    expect(JSON.stringify(found)).not.toContain("PRIVATE-");
    host.id = "focus";
    const scoped = buttons(await snapshot({ 0: dom }, { target: "#focus" }));
    expect(scoped.map((button) => button.dupContext)).toEqual([unavailable, unavailable]);
  });

  it("rejects a Vue 3 table with a duplicate key outside the rendered rows", async () => {
    const dom = newDom();
    const host = mount(dom, null,
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const app = dom.window.document.createElement("div");
    host.before(app);
    app.appendChild(host);
    (app as any).__vue_app__ = { _instance: null };
    (app as any)._vnode = { component: { subTree: { children: [{
      el: host, component: { proxy: table(entries(["K", "L", "K"])), subTree: { el: host } },
    }] } } };
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toBe(unavailable);
    expect(found[1].dupContext).toContain("订单乙");
  });

  it.each(["light", "shadow"])("keeps VXE row context inside the target in %s DOM", async (kind) => {
    const dom = newDom();
    const rows = entries(["K", "L"]);
    const host = mount(dom, table(rows),
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    host.id = "focus";
    if (kind === "shadow") {
      const shadowHost = dom.window.document.createElement("div");
      dom.window.document.body.appendChild(shadowHost);
      shadowHost.attachShadow({ mode: "open" }).appendChild(host);
    }
    const found = buttons(await snapshot({ 0: dom }, { target: "#focus" }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext).toContain("订单甲");
    expect(found[1].dupContext).toContain("订单乙");
  });
  it("does not inspect or join VXE fragments outside a target", async () => {
    const dom = newDom();
    const host = mount(dom, table(entries(["K", "L"])),
      fragment("main", [{ id: "K", content: "Outside secret" }, { id: "L", content: "Outside other" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const scoped = host.querySelector('[data-side="right"]')!;
    scoped.id = "focus";
    const query = vi.spyOn(host, "querySelectorAll");
    const found = buttons(await snapshot({ 0: dom }, { target: "#focus" }));
    expect(found).toHaveLength(2);
    expect(JSON.stringify(found)).not.toContain("Outside");
    expect(query).not.toHaveBeenCalled();
  });

  it("joins unique encoded keys across main and both fixed fragments for duplicate actions without exposing row objects", async () => {
    const dom = newDom();
    const rows = entries(["甲 %/1", "乙 %/2"]);
    mount(dom, table(rows),
      fragment("main", [{ id: rows[0].id, content: "订单甲" }, { id: rows[1].id, content: "订单乙" }]) +
      fragment("left", [{ id: rows[0].id, content: "左甲" }, { id: rows[1].id, content: "左乙" }]) +
      fragment("right", [{ id: rows[0].id, content: action("a") }, { id: rows[1].id, content: action("b") }]));
    const result = await snapshot({ 0: dom });
    const found = buttons(result);
    expect(found).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    expect(found[0].dupContext ?? "").toContain("订单甲");
    expect(found[0].dupContext).toContain("左甲");
    expect(found[1].dupContext).toContain("订单乙");
    expect(found[1].dupContext).not.toContain("订单甲");
  });

  it.each(["duplicate objects", "same object twice", "missing instance", "missing collection", "missing key method"])("marks %s unavailable instead of guessing", async (scenario) => {
    const dom = newDom();
    const rows = entries(["K", "L"]);
    if (scenario === "duplicate objects") rows.push({ id: "K", privateValue: "PRIVATE-collision" });
    if (scenario === "same object twice") rows.push(rows[0]);
    const instance = table(rows);
    if (scenario === "missing collection") delete instance.getTableData;
    if (scenario === "missing key method") delete instance.getRowid;
    mount(dom, scenario === "missing instance" ? null : instance,
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const result = await snapshot({ 0: dom });
    const found = buttons(result);
    expect(found).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    expect(found[0].dupContext).toBe(unavailable);
  });

  it("does not take matching-key text from a different table instance", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])), fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    mount(dom, table(entries(["K", "L"])), fragment("main", [{ id: "K", content: "另一表甲" }, { id: "L", content: "另一表乙" }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found.map((e) => e.dupContext)).toEqual([unavailable, unavailable]);
  });

  it("does not take matching-key text from another frame", async () => {
    const top = newDom();
    const child = newDom();
    mount(top, table(entries(["K", "L"])), fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    mount(child, table(entries(["K", "L"])), fragment("main", [{ id: "K", content: `子帧甲<button>子帧操作</button>` }, { id: "L", content: "子帧乙" }]));
    const result = await snapshot({ 0: top, 1: child }, { frames: "all-same-origin" });
    expect(result.elements.some((e) => e.name === "子帧操作" && e.frameId === 1)).toBe(true);
    const found = buttons(result);
    expect(found).toHaveLength(2);
    expect(found.map((e) => e.dupContext)).toEqual([unavailable, unavailable]);
  });

  it("isolates contexts between instances with the same keys while retaining local context", async () => {
    const dom = newDom();
    for (const label of ["甲表", "乙表"]) {
      mount(dom, table(entries(["K", "L"])),
        fragment("main", [{ id: "K", content: `${label}订单一` }, { id: "L", content: `${label}订单二` }]) +
        fragment("right", [{ id: "K", content: action(`${label}a`) }, { id: "L", content: action(`${label}b`) }]));
    }
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(4);
    expect(found[0].dupContext ?? "").not.toContain("乙表");
    expect(found[2].dupContext ?? "").not.toContain("甲表");
    expect(found[0].dupContext ?? "").toContain("甲表订单一");
    expect(found[2].dupContext ?? "").toContain("乙表订单一");
  });

  it("uses only visible row text, excluding hidden, collapsed and clipped fields", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])),
      fragment("main", [
        { id: "K", content: `可见甲<span style="display:none">隐藏秘密</span><details><summary>折叠标题</summary><span>折叠秘密</span></details><span style="overflow:hidden;width:10px" data-clipped><span>裁剪秘密</span></span>` },
        { id: "L", content: "可见乙" },
      ]) + fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").not.toMatch(/隐藏秘密|折叠秘密|裁剪秘密/);
    expect(found[0].dupContext ?? "").toContain("可见甲");
  });

  it("re-evaluates rowid and current DOM text when a virtualized tr is reused", async () => {
    const dom = newDom();
    const host = mount(dom, table(entries(["K", "L", "M"])),
      fragment("main", [{ id: "K", content: "旧订单" }, { id: "L", content: "另一订单" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const first = buttons(await snapshot({ 0: dom }));
    expect(first).toHaveLength(2);
    const main = host.querySelector('[data-side="main"] tr')!;
    const right = host.querySelector('[data-side="right"] tr')!;
    main.setAttribute("rowid", "M");
    right.setAttribute("rowid", "M");
    main.firstElementChild!.textContent = "新订单";
    const second = buttons(await snapshot({ 0: dom }));
    expect(second).toHaveLength(2);
    expect(second[0].dupContext ?? "").not.toContain("旧订单");
    expect(second[0].dupContext ?? "").toContain("新订单");
  });

  // 审核1:真实 VXE 层级里最近的 __vue__ 是 body 组件(VxeTableBody),VxeTable 实例在
  // $parent 链上 —— 不能因为「最近的 __vue__ 不是 VxeTable」就判定证不出实例。
  it("locates the table instance through the body component's $parent chain", async () => {
    const dom = newDom();
    const rows = entries(["K", "L"]);
    const instance = table(rows);
    const host = mount(dom, instance,
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    for (const w of Array.from(host.querySelectorAll(".vxe-table--body-wrapper"))) {
      (w as any).__vue__ = { $options: { name: "VxeTableBody" }, $parent: instance };
    }
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").toContain("订单甲");
    expect(found[0].dupContext).not.toBe(unavailable);
  });

  // 审核2:overflow 容器的直接文本、折叠 details 的直接文本都证不出可见 → 必须省略。
  it("omits direct text of overflow containers and collapsed details", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])),
      fragment("main", [
        { id: "K", content: `可见甲<span style="overflow:hidden;width:10px" data-clipped>裁剪直文本</span><details><summary>折叠标题</summary>折叠直文本</details>` },
        { id: "L", content: "可见乙" },
      ]) + fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").not.toContain("裁剪直文本");
    expect(found[0].dupContext ?? "").not.toContain("折叠直文本");
    expect(found[0].dupContext ?? "").toContain("可见甲");
  });

  // 审核3:身份不可关联时 [row-context-unavailable] 优先 —— 旧祖先回退会把隐藏字段带出来。
  it("prefers the unavailable marker over the ancestor fallback", async () => {
    const dom = newDom();
    mount(dom, null,
      fragment("main", [
        { id: "K", content: `订单甲<span style="display:none">隐藏秘密</span><button id="a">详情</button>` },
        { id: "L", content: `订单乙<span style="display:none">隐藏秘密乙</span><button id="b">详情</button>` },
      ]));
    const result = await snapshot({ 0: dom });
    const found = buttons(result);
    expect(found).toHaveLength(2);
    expect(found.map((e) => e.dupContext)).toEqual([unavailable, unavailable]);
    expect(JSON.stringify(result)).not.toContain("隐藏秘密");
  });

  // 审核4:外表读行上下文时不得递归进嵌套的另一个实例。
  it("does not pull a nested table instance into the outer row context", async () => {
    const dom = newDom();
    const host = mount(dom, table(entries(["K", "L"])),
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const cell = host.querySelector('[data-side="main"] tr td')!;
    const nested = dom.window.document.createElement("div");
    nested.className = "vxe-table";
    nested.innerHTML = '<div class="vxe-table--body-wrapper"><table><tbody><tr rowid="K"><td>嵌套秘密</td></tr></tbody></table></div>';
    (nested as any).__vue__ = table(entries(["K", "L"]));
    cell.appendChild(nested);
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").toContain("订单甲");
    expect(found[0].dupContext ?? "").not.toContain("嵌套秘密");
  });

  // 复审1:内嵌 VXE 表拿不到实例(无 __vue__)→ 不许上溯认领外表实例,不得跨表关联。
  it("does not claim the outer instance for a nested VXE table without __vue__", async () => {
    const dom = newDom();
    const host = mount(dom, table(entries(["K", "L"])),
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const cell = host.querySelector('[data-side="main"] tr td')!;
    const nested = dom.window.document.createElement("div");
    nested.className = "vxe-table";   // 内嵌表根:没有 __vue__ → 证不出实例
    nested.innerHTML = '<div class="vxe-table--body-wrapper"><table><tbody>'
      + '<tr rowid="K"><td>嵌套甲<button>详情</button></td></tr>'
      + '<tr rowid="L"><td>嵌套乙<button>详情</button></td></tr>'
      + "</tbody></table></div>";
    cell.appendChild(nested);
    const found = buttons(await snapshot({ 0: dom }));
    const ctxs = found.map((e) => e.dupContext ?? "");
    expect(found).toHaveLength(4);
    // 内嵌表的两个按钮:证不出实例 → 降级标记;外表两个按钮:各自的行文本。
    expect(ctxs.filter((c) => c === unavailable)).toHaveLength(2);
    expect(ctxs.filter((c) => c.includes("订单甲"))).toHaveLength(1);
    expect(ctxs.filter((c) => c.includes("订单乙"))).toHaveLength(1);
    // 跨表关联:内嵌行文本不得并进任何上下文。
    expect(ctxs.some((c) => c.includes("嵌套甲") || c.includes("嵌套乙"))).toBe(false);
  });

  // 复审2:候选片段的任一祖先 display:none → 该片段内容禁止输出。
  it("omits a candidate fragment whose ancestor is display:none", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])),
      fragment("main", [{ id: "K", content: "可见甲" }, { id: "L", content: "可见乙" }]) +
      `<div class="vxe-table--body-wrapper fixed-left--wrapper" data-side="left" style="display:none"><table><tbody>` +
      `<tr class="vxe-body--row" rowid="K"><td>隐藏秘密甲</td></tr></tbody></table></div>` +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").toContain("可见甲");
    expect(found[0].dupContext ?? "").not.toContain("隐藏秘密甲");
  });

  // 复审3:逐层检查全部 overflow 裁剪祖先 —— 内层没裁到不算,外层裁到就算。
  it("checks every overflow clipping ancestor, not only the innermost", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])),
      fragment("main", [{ id: "K", content: "可见甲" }, { id: "L", content: "可见乙" }]) +
      `<div style="overflow:hidden" data-box="0,0,50,100">` +
      `<div class="vxe-table--body-wrapper fixed-left--wrapper" data-side="left" style="overflow:hidden"><table><tbody>` +
      `<tr class="vxe-body--row" rowid="K"><td>裁剪秘密</td></tr></tbody></table></div></div>` +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").toContain("可见甲");
    expect(found[0].dupContext ?? "").not.toContain("裁剪秘密");
  });

  // 复审5:内嵌表内层的组件 $parent 链指向外表实例 → 也不许让内嵌行认领它。
  it("does not claim an outer instance through a nested table's inner component", async () => {
    const dom = newDom();
    const instance = table(entries(["K", "L"]));
    const host = mount(dom, instance,
      fragment("main", [{ id: "K", content: "订单甲" }, { id: "L", content: "订单乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const cell = host.querySelector('[data-side="main"] tr td')!;
    const nested = dom.window.document.createElement("div");
    nested.className = "vxe-table";   // 内嵌表根:没有 __vue__
    nested.innerHTML = '<div class="vxe-table--body-wrapper"><table><tbody>'
      + '<tr rowid="K"><td>嵌套甲<button>详情</button></td></tr></tbody></table></div>';
    // 内层组件的 $parent 链指向外表实例 —— 不能靠它把内嵌行认领成外表行。
    (nested.querySelector(".vxe-table--body-wrapper") as any).__vue__ = { $options: { name: "VxeTableBody" }, $parent: instance };
    cell.appendChild(nested);
    const found = buttons(await snapshot({ 0: dom }));
    const ctxs = found.map((e) => e.dupContext ?? "");
    expect(found).toHaveLength(3);
    expect(ctxs.filter((c) => c === unavailable)).toHaveLength(1);
    expect(ctxs.filter((c) => c.includes("订单甲"))).toHaveLength(1);
    expect(ctxs.some((c) => c.includes("嵌套甲"))).toBe(false);
  });

  // 复审6:滚动容器自身被外层裁掉时,容器里完全可见的行仍要保留上下文。
  it("keeps a fully visible row inside a scrollport that is itself clipped", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])),
      `<div style="overflow:hidden" data-box="0,0,100,300">` +
      `<div class="vxe-table--body-wrapper body--wrapper" data-side="main" style="overflow:auto" data-box="0,0,200,100">` +
      `<table><tbody>` +
      `<tr class="vxe-body--row" rowid="K" data-box="10,10,90,40"><td>可见甲</td></tr>` +
      `<tr class="vxe-body--row" rowid="L" data-box="10,150,90,180"><td>折下秘密</td></tr>` +
      "</tbody></table></div></div>" +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found).toHaveLength(2);
    expect(found[0].dupContext ?? "").toContain("可见甲");
    expect(found[0].dupContext ?? "").not.toContain("折下秘密");
  });

  it("retains visible cell text in a partially clipped wide row", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])),
      `<div style="overflow:hidden" data-box="0,0,100,100"><div class="vxe-table--body-wrapper"><table><tbody>` +
      `<tr rowid="K" data-box="0,10,300,40"><td data-box="10,10,80,40">可见单元格</td><td data-box="150,10,220,40">裁剪单元格</td></tr>` +
      `</tbody></table></div></div>` +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found[0].dupContext).toContain("可见单元格");
    expect(found[0].dupContext).not.toContain("裁剪单元格");
  });

  it("keeps complete ellipsis text but omits genuinely truncated text", async () => {
    const dom = newDom();
    const host = mount(dom, table(entries(["K", "L"])),
      fragment("main", [{ id: "K", content: `<div class="vxe-cell" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">完整文本</div><div class="vxe-cell" id="cut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">截断秘密</div>` }, { id: "L", content: "乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    for (const el of host.querySelectorAll(".vxe-cell")) {
      Object.defineProperty(el, "clientWidth", { value: 80 });
      Object.defineProperty(el, "scrollWidth", { value: el.id === "cut" ? 120 : 80 });
    }
    const found = buttons(await snapshot({ 0: dom }));
    expect(found[0].dupContext).toContain("完整文本");
    expect(found[0].dupContext).not.toContain("截断秘密");
  });

  it.each([{}, { childrenField: "nodes" }])("degrades tree rows for config %j even with parent-child duplicate keys", async (config) => {
    const dom = newDom();
    const rows = entries(["K", "L"]);
    (rows[0] as any)["nodes" in config ? "nodes" : "children"] = [{ id: "K", privateValue: "secret" }];
    const instance = table(rows);
    (instance as any).treeConfig = config;
    mount(dom, instance, fragment("main", [{ id: "K", content: "父行" }, { id: "L", content: "乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    expect(buttons(await snapshot({ 0: dom })).map((e) => e.dupContext)).toEqual([unavailable, unavailable]);
  });

  it("omits text with a transparent ancestor", async () => {
    const dom = newDom();
    mount(dom, table(entries(["K", "L"])),
      fragment("main", [{ id: "K", content: `可见<span style="opacity:0"><span>透明秘密</span></span>` }, { id: "L", content: "乙" }]) +
      fragment("right", [{ id: "K", content: action("a") }, { id: "L", content: action("b") }]));
    const found = buttons(await snapshot({ 0: dom }));
    expect(found[0].dupContext).toContain("可见");
    expect(found[0].dupContext).not.toContain("透明秘密");
  });

  // 复审4:VXE 非行工具栏 → 保留原有祖先上下文,不当作行身份失败。
  it("keeps the ancestor context for a VXE toolbar button outside any row", async () => {
    const dom = newDom();
    const host = dom.window.document.createElement("div");
    host.className = "vxe-table";
    host.innerHTML = '<div class="vxe-toolbar"><div class="left">批量操作 <button>导出</button></div>'
      + '<div class="right">筛选 <button>导出</button></div></div>';
    (host as any).__vue__ = table(entries(["K", "L"]));
    dom.window.document.body.appendChild(host);
    const found = (await snapshot({ 0: dom })).elements.filter((e) => e.tag === "button" && e.name === "导出");
    expect(found).toHaveLength(2);
    expect(found.map((e) => e.dupContext)).not.toContain(unavailable);
    expect(found[0].dupContext ?? "").toContain("批量操作");
    expect(found[1].dupContext ?? "").toContain("筛选");
  });
});
