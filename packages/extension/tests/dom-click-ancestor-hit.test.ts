/**
 * Author: qingwa
 * Description: 合成 click 路径(element.click())的遮挡检查与 CDP 路径、门三者同判据。
 *   合成 click 本身绕过 hit-test(2026-08-15 spike 实测:三种祖先命中场景在合成路径下
 *   全部"点中"),所以这道检查是合成路径唯一的真实性保障。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { classifyHit } from "../src/page-side/hit-ownership.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/auto-wait.js", () => ({ waitActionable: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

let dom: JSDOM;
let lastResult: any;
let router: ActionRouter;
let execCount = 0;

// 捕获真实注入 func 并 new Function 剥离模块闭包后执行（同
// tests/click-synthetic-inline-scope.test.ts）。source-grep 测不出注入期问题。
function setup(ancestorHtml: string) {
  dom = new JSDOM(`<body>${ancestorHtml}</body>`, { pretendToBeVisual: true });
  const win = dom.window as any;
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  // MAIN world 注入环境天然有这些全局(真实 Chrome 页面);new Function 剥离作用域后
  // 靠裸标识符解析,jsdom 不提供,须补——同 click-synthetic-inline-scope.test.ts。
  for (const g of ["HTMLElement", "HTMLInputElement", "MouseEvent", "Event", "getComputedStyle"]) {
    (globalThis as any)[g] = g === "getComputedStyle" ? win.getComputedStyle.bind(win) : win[g];
  }
  (globalThis as any).PointerEvent = win.MouseEvent;
  win.PointerEvent = win.MouseEvent;
  const btn = win.document.getElementById("b")!;
  const wrap = win.document.getElementById("w")!;
  btn.getBoundingClientRect = () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, left: 10, right: 30, bottom: 30 });
  Object.defineProperty(win.document, "elementFromPoint", { value: () => wrap, configurable: true });
  win.__vortexDomResolve = {
    queryAllDeep: (s: string) => Array.from(win.document.querySelectorAll(s)),
    deepElementFromPoint: () => wrap,
    isEnabled: () => true,
    classifyHit: (a: Element, b: Element | null) => classifyHit(a, b),
  };
  execCount = 0;
  (globalThis as any).chrome = {
    scripting: {
      executeScript: async ({ func, args }: { func: Function; args?: unknown[] }) => {
        execCount++;
        const stripped = new Function("return (" + String(func) + ")")();
        const r = await stripped(...(args ?? []));
        lastResult = r;
        return [{ result: r }];
      },
    },
  };
  router = new ActionRouter();
  registerDomHandlers(router, undefined as any);
}

const click = (args: Record<string, unknown>) =>
  router.dispatch({ type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" } as NmRequest);

beforeEach(() => vi.clearAllMocks());

describe("合成 click 祖先命中", () => {
  it("非交互祖先 → ELEMENT_OCCLUDED（注入期真执行）", async () => {
    setup(`<div id="w" class="row"><button id="b">x</button></div>`);
    await click({ selector: "#b" });
    expect(lastResult).toMatchObject({ errorCode: "ELEMENT_OCCLUDED", extras: { hitKind: "ancestor" } });
  });

  it("祖先带 transform（swiper 轨道）仍被拦——transient 豁免不适用于祖先命中", async () => {
    setup(`<div id="w" style="transform: translateX(-400px)"><button id="b">题3</button></div>`);
    // jsdom 不算 computed transform，直接让 isTransient 的判据命中 aria-hidden 等价物：
    dom.window.document.getElementById("w")!.setAttribute("aria-hidden", "true");
    await click({ selector: "#b" });
    expect(lastResult).toMatchObject({ errorCode: "ELEMENT_OCCLUDED", extras: { hitKind: "ancestor" } });
  });

  it("transient 兄弟浮层仍豁免（回归保护，kind=overlay 才吃豁免）", async () => {
    setup(`<div id="w" aria-hidden="true">mask</div><button id="b">x</button>`);
    const win = dom.window as any;
    const mask = win.document.getElementById("w")!;
    win.__vortexDomResolve.deepElementFromPoint = () => mask;
    Object.defineProperty(win.document, "elementFromPoint", { value: () => mask, configurable: true });
    await click({ selector: "#b" });
    expect(lastResult?.errorCode).toBeUndefined();
  });

  it("投递给调用方的 payload：祖先话术 + 覆盖 hint，不指向浮层", async () => {
    setup(`<div id="w" class="row"><button id="b">x</button></div>`);
    const resp: any = await click({ selector: "#b" });
    expect(resp.error.code).toBe("ELEMENT_OCCLUDED");
    expect(resp.error.message).toMatch(/ancestor/i);
    expect(resp.error.message).not.toMatch(/covered by/i);
    expect(resp.error.hint).toMatch(/ancestor/i);
    expect(resp.error.hint).not.toMatch(/cookie banner|dismiss it via/i);
  });

  it("兄弟浮层命中仍是既有遮挡话术与 hint（回归保护）", async () => {
    setup(`<div id="w" class="mask">mask</div><button id="b">x</button>`);
    const win = dom.window as any;
    const mask = win.document.getElementById("w")!;
    win.__vortexDomResolve.deepElementFromPoint = () => mask;
    const resp: any = await click({ selector: "#b" });
    expect(resp.error.code).toBe("ELEMENT_OCCLUDED");
    expect(resp.error.message).toMatch(/covered by <div#w\.mask>/);
    expect(resp.error.hint).toMatch(/cookie banner/i);
  });

  it("force=true → 跳过判定（与 CDP 路径对齐）", async () => {
    setup(`<div id="w" class="row"><button id="b">x</button></div>`);
    await click({ selector: "#b", force: true });
    expect(lastResult?.errorCode).toBeUndefined();
  });

  it("classifyHit 不可用 → fail closed 报 NOT_ATTACHED", async () => {
    setup(`<div id="w" class="row"><button id="b">x</button></div>`);
    delete (dom.window as any).__vortexDomResolve.classifyHit;
    await click({ selector: "#b" });
    expect(lastResult).toMatchObject({ errorCode: "NOT_ATTACHED" });
  });
});
