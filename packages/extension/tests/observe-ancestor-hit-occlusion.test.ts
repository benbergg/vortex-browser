/**
 * Author: qingwa
 * Description: observe 的遮挡判定必须与 act 的门同判据。祖先裁剪的元素若在 observe 里
 *   报 visible:true,模型据此认为可点,act 却抛 OBSCURED——探测与门相互矛盾。
 *   本测试真执行 inject 的扫描体(new Function 剥离模块作用域),不做源码正则。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";
import { classifyHit } from "../src/page-side/hit-ownership.js";
import { loadPageSideModule } from "../src/adapter/page-side-loader.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));

function setupDom(html: string, hitId: string, withResolve = true) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    pretendToBeVisual: true,
    url: "https://x/",
  });
  const win = dom.window as any;
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  // inject 环境天然有这些全局;new Function 剥离作用域后靠裸标识符解析,jsdom 须补。
  for (const g of [
    "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node",
    "ShadowRoot", "DocumentFragment", "SVGElement", "NodeFilter", "Text", "Comment",
  ]) {
    (globalThis as any)[g] = win[g];
  }
  (globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
  (globalThis as any).location = win.location;
  (globalThis as any).CSS = { escape: (v: string) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
  // jsdom 无布局:所有元素给同一非零 rect,否则 inViewport=false 直接跳过遮挡判定。
  for (const el of Array.from(win.document.querySelectorAll("*"))) {
    (el as any).getBoundingClientRect = () => ({
      x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50,
    });
  }
  const hit = win.document.getElementById(hitId);
  Object.defineProperty(win.document, "elementFromPoint", { value: () => hit, configurable: true });
  if (withResolve) {
    win.__vortexDomResolve = {
      version: 2,
      classifyHit: (el: Element, top: Element | null) => classifyHit(el, top),
    };
  }
  return dom;
}

function stubChrome() {
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
    },
    scripting: {
      // 真执行注入体:String(func) 后重新求值,模块作用域在此彻底丢失。
      executeScript: vi.fn(async ({ func, args }: any) => {
        if (typeof func !== "function") return [{ result: null }];
        const stripped = new Function("return (" + String(func) + ")")();
        return [{ result: await stripped(...(args ?? [])) }];
      }),
    },
    runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
  });
}

async function observeFirst(html: string, hitId: string, withResolve = true) {
  setupDom(html, hitId, withResolve);
  stubChrome();
  const router = new ActionRouter();
  registerObserveHandlers(router);
  const resp: any = await router.dispatch({
    type: "tool_request", tool: "observe.snapshot", args: {}, requestId: "r", tabId: 42,
  } as NmRequest);
  expect(resp.error).toBeUndefined();
  return resp.result.elements as Array<Record<string, unknown>>;
}

beforeEach(() => vi.mocked(loadPageSideModule).mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("observe 遮挡判定与门同判据", () => {
  // 判定本身正确不代表生产里跑得到:扫描体拿 classifyHit 的前提是这一帧真注入过
  // dom-resolve。缺这条断言时,删掉 scanOneFrame 里的注入整行,本文件仍然全绿。
  it("扫描前把 dom-resolve 注进目标 frame（承重接线）", async () => {
    await observeFirst(`<button id="b">确定</button>`, "b");
    expect(vi.mocked(loadPageSideModule)).toHaveBeenCalledWith(42, 0, "dom-resolve");
  });

  it("祖先裁剪命中 → visible:false 且点名祖先（与门的 ancestor 判定一致）", async () => {
    const els = await observeFirst(`<div id="clip"><button id="b">确定</button></div>`, "clip");
    expect(els).toHaveLength(1);
    expect(els[0].visible).toBe(false);
    expect(els[0].occludedBy).toBe("div#clip");
  });

  it("阻挡祖先嵌在 role 容器内 → 仍 visible:false（装饰层 carve-out 不得吞掉）", async () => {
    const els = await observeFirst(
      `<div role="tabpanel"><div id="clip"><button id="b">确定</button></div></div>`,
      "clip",
    );
    const btn = els.find((e) => e.tag === "button")!;
    expect(btn.visible).toBe(false);
    expect(btn.occludedBy).toBe("div#clip");
  });

  it("兄弟浮层命中 → visible:false（回归保护，也证明遮挡分支确实执行了）", async () => {
    const els = await observeFirst(`<button id="b">确定</button><div id="ov">mask</div>`, "ov");
    const btn = els.find((e) => e.tag === "button")!;
    expect(btn.visible).toBe(false);
    expect(btn.occludedBy).toBe("div#ov");
  });

  it("命中自己 → visible:true（回归保护）", async () => {
    const els = await observeFirst(`<button id="b">确定</button>`, "b");
    expect(els[0].visible).toBe(true);
    expect(els[0].occludedBy).toBeUndefined();
  });

  it("el-select 装饰层兄弟命中 → visible:true（carve-out 回归保护）", async () => {
    const els = await observeFirst(
      `<div role="combobox"><input id="i" placeholder="请选择"><span id="disp">请选择</span></div>`,
      "disp",
    );
    const input = els.find((e) => e.tag === "input")!;
    expect(input.visible).toBe(true);
    expect(input.occludedBy).toBeUndefined();
  });
});
