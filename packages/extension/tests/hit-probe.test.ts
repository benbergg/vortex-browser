/**
 * Author: qingwa
 * Description: 坐标点击命中自证 —— CDP 点在浮层上和点中目标返回一模一样的 success:true。
 *
 * 2026-08-14 日志实证:某会话 35 次 mouse_click，同一坐标被反复重点（(714,755) 三次），
 * 页面自己的 elementFromPoint 探测显示插入面板压住卡片区 302px、48 个按钮 32 个被挡。
 * Input.dispatchMouseEvent 做的是浏览器真实命中测试，事件确实发生了，只是落在面板上；
 * 而 handler 无条件 return success:true 且只回显入参坐标，调用方拿不到任何线索。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { hitProbePageSide, isHitProbe } from "../src/lib/hit-probe.js";

function setupDom(html = "<body></body>") {
  const dom = new JSDOM(html, { url: "https://example.test/" });
  vi.stubGlobal("window", dom.window as unknown as Window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  return dom;
}

/** jsdom 不实现 elementFromPoint，按测试意图挂上去。 */
function stubHit(doc: Document, fn: (x: number, y: number) => Element | null) {
  (doc as unknown as { elementFromPoint: unknown }).elementFromPoint = fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hitProbePageSide", () => {
  it("视口外坐标报 OUT_OF_VIEWPORT 并带上视口尺寸", () => {
    // 日志实测:调用方拿了未滚动的 rect，y=-3974 白点一整轮仍 success:true
    setupDom();
    const r = hitProbePageSide(922, -3974);
    expect(r).toEqual({
      ok: false,
      reason: "OUT_OF_VIEWPORT",
      viewport: { w: 1024, h: 768 },
    });
  });

  it("坐标超出右/下边界同样判视口外", () => {
    setupDom();
    expect(hitProbePageSide(1024, 100)).toMatchObject({ reason: "OUT_OF_VIEWPORT" });
    expect(hitProbePageSide(100, 768)).toMatchObject({ reason: "OUT_OF_VIEWPORT" });
    // 边界内侧必须仍可探测，否则右下角元素全被误判
    stubHit(document, () => document.body);
    expect(hitProbePageSide(1023, 767)).toMatchObject({ ok: true });
  });

  it("被浮层遮挡时报出的是浮层，不是调用方以为的按钮", () => {
    const dom = setupDom(`<body>
      <button id="save" class="btn btn-primary">保存</button>
      <div class="insert-pane chakra-stack css-2xph3x">插入面板</div>
    </body>`);
    const doc = dom.window.document;
    const pane = doc.querySelector(".insert-pane")!;
    stubHit(doc, () => pane);

    const r = hitProbePageSide(714, 755);
    expect(r).toEqual({
      ok: true,
      el: "DIV.insert-pane.chakra-stack",
      text: "插入面板",
    });
  });

  it("命中元素带 id 时优先给 id", () => {
    const dom = setupDom(`<body><button id="save" class="btn">保存</button></body>`);
    const btn = dom.window.document.querySelector("#save")!;
    stubHit(dom.window.document, () => btn);
    expect(hitProbePageSide(10, 10)).toMatchObject({ el: "BUTTON#save.btn", text: "保存" });
  });

  it("视口内但该点什么都没有 → NO_ELEMENT", () => {
    const dom = setupDom();
    stubHit(dom.window.document, () => null);
    expect(hitProbePageSide(10, 10)).toEqual({ ok: false, reason: "NO_ELEMENT" });
  });

  it("下钻 open shadow root，报真实叶子而非 host", () => {
    // elementFromPoint 把 shadow-internal 的命中重定向到 host,不下钻就永远报 host
    const dom = setupDom("<body><my-card></my-card></body>");
    const doc = dom.window.document;
    const host = doc.querySelector("my-card")! as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button class="inner">确定</button>`;
    const leaf = sr.querySelector("button")!;
    stubHit(doc, () => host);
    (sr as unknown as { elementFromPoint: unknown }).elementFromPoint = () => leaf;

    expect(hitProbePageSide(50, 50)).toMatchObject({ el: "BUTTON.inner", text: "确定" });
  });

  it("同源 iframe 继续下钻并换算坐标，framePath 记录穿过的层", () => {
    const dom = setupDom(`<body><iframe id="voc"></iframe></body>`);
    const doc = dom.window.document;
    const iframe = doc.querySelector("iframe")! as HTMLIFrameElement;
    iframe.getBoundingClientRect = (() => ({ left: 100, top: 50 })) as never;
    const sub = iframe.contentDocument!;
    sub.body.innerHTML = `<a class="link">详情</a>`;
    const link = sub.querySelector("a")!;
    let seen: { x: number; y: number } | null = null;
    stubHit(doc, () => iframe);
    (sub as unknown as { elementFromPoint: unknown }) .elementFromPoint = (x: number, y: number) => {
      seen = { x, y };
      return link;
    };

    const r = hitProbePageSide(300, 200);
    expect(seen).toEqual({ x: 200, y: 150 });
    expect(r).toEqual({ ok: true, el: "A.link", text: "详情", framePath: ["IFRAME#voc"] });
  });

  it("跨源 iframe 读不到 contentDocument 时停在 IFRAME 这层，不假装看得更深", () => {
    const dom = setupDom(`<body><iframe id="ext"></iframe></body>`);
    const doc = dom.window.document;
    const iframe = doc.querySelector("iframe")!;
    Object.defineProperty(iframe, "contentDocument", {
      get() {
        throw new Error("SecurityError: cross-origin");
      },
    });
    stubHit(doc, () => iframe);

    expect(hitProbePageSide(10, 10)).toMatchObject({ ok: true, el: "IFRAME#ext" });
  });

  it("长文本截断到 40 字，不把整块面板正文塞进结果", () => {
    const dom = setupDom(`<body><div>${"字".repeat(200)}</div></body>`);
    const el = dom.window.document.querySelector("div")!;
    stubHit(dom.window.document, () => el);
    const r = hitProbePageSide(10, 10) as { text: string };
    expect(r.text).toHaveLength(40);
  });

  it("注入体不引用任何模块作用域绑定", () => {
    // executeScript 只搬运函数源码；引用了模块变量在页面里就是 X is not defined。
    // 靠 new Function 剥掉词法作用域复刻注入，否则单测在模块图里跑必然假绿。
    const dom = setupDom("<body><span>ok</span></body>");
    stubHit(dom.window.document, () => dom.window.document.querySelector("span"));
    const detached = new Function(`return (${hitProbePageSide.toString()})`)() as typeof hitProbePageSide;
    expect(detached(10, 10)).toMatchObject({ el: "SPAN", text: "ok" });
  });
});

describe("isHitProbe", () => {
  it("放行两种合法形状", () => {
    expect(isHitProbe({ ok: true, el: "DIV" })).toBe(true);
    expect(isHitProbe({ ok: false, reason: "NO_ELEMENT" })).toBe(true);
    expect(isHitProbe({ ok: false, reason: "OUT_OF_VIEWPORT", viewport: { w: 1, h: 1 } })).toBe(true);
  });

  it("挡掉其他 executeScript 返回值 —— 同一 mock 会喂进来 iframe offset 这类对象", () => {
    expect(isHitProbe({ x: 60, y: 0 })).toBe(false);
    expect(isHitProbe(null)).toBe(false);
    expect(isHitProbe("ok")).toBe(false);
    expect(isHitProbe({ ok: true })).toBe(false);
    expect(isHitProbe({ ok: false, reason: "WHATEVER" })).toBe(false);
  });
});
