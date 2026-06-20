import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";

/**
 * content-isolated dialog.opened 消息源校验回归锁(CWE-345 跨域消息伪造,白盒实机复现 2026-06-20)。
 *
 * 现象:content-isolated.ts 的 message listener 只校验 `data.__vortex__ === true`,不校验
 *   `ev.source`。合法 bridge 是**同 frame** MAIN world(content-main)→ ISOLATED world 的
 *   `window.postMessage`(ev.source 必为本 window)。但任意页面脚本 / 跨域子 iframe 经
 *   `window.top.postMessage({__vortex__:true,type:"dialog.opened",text:...},"*")` 即可伪造
 *   dialog.opened 事件,被原样转发给 background → MCP 事件流(text 由攻击者控制,url 取
 *   listener 所在顶 frame,伪装成顶页真实弹框)。
 *   live: example.com 内嵌 opaque-origin 子 frame,window.top.postMessage 伪造消息通过当前
 *   唯一守卫(sourceIsWindow=false → ev.source===window 检查可拦)。
 *
 * 修复:listener 加 `if (ev.source !== window) return;`——只认本 frame 自身 window 的消息。
 */
function postMsg(win: Window, data: unknown, source: unknown): void {
  const ev = new (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent("message", { data } as MessageEventInit);
  // jsdom 对 MessageEventInit.source 支持不稳;用 defineProperty 强制设定确保可控。
  Object.defineProperty(ev, "source", { value: source, configurable: true });
  win.dispatchEvent(ev);
}

describe("content-isolated dialog.opened 源校验(CWE-345)", () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let dom: JSDOM;

  beforeEach(async () => {
    dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://top.example/" });
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    // content-isolated 的 send() 用裸 `location.href`,node 环境须显式提供 location。
    (globalThis as unknown as { location: Location }).location = dom.window.location;
    sendMessage = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    };
    vi.resetModules();
    // IIFE:导入即注册 window message listener。
    await import("../src/content-isolated.js");
  });
  afterEach(() => {
    vi.resetModules();
    sendMessage.mockReset();
  });

  const forged = { __vortex__: true, type: "dialog.opened", kind: "prompt", text: "FORGED" };

  it("跨 frame 伪造消息(ev.source !== window)→ 不转发", () => {
    // 模拟子 iframe / 其它窗口:source 是别的 window 对象,非本 window。
    postMsg(dom.window as unknown as Window, forged, { name: "child-iframe-window" });
    const dialogCalls = sendMessage.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === "dialog.opened",
    );
    expect(dialogCalls).toHaveLength(0);
  });

  it("source=null(opaque/跨域常见)→ 不转发", () => {
    postMsg(dom.window as unknown as Window, forged, null);
    const dialogCalls = sendMessage.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === "dialog.opened",
    );
    expect(dialogCalls).toHaveLength(0);
  });

  it("合法同 frame 消息(ev.source === window)→ 正常转发", () => {
    postMsg(dom.window as unknown as Window, { ...forged, text: "real" }, dom.window);
    const dialogCalls = sendMessage.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === "dialog.opened",
    );
    expect(dialogCalls).toHaveLength(1);
    expect((dialogCalls[0][0] as { data: { text: string } }).data.text).toBe("real");
  });
});
