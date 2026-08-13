/**
 * Author: qingwa
 * Description: TYPE 回读值契约与长度上限。typed 返回的是入参字符数不是写入结果，
 *   编辑器规范化或部分拒收时两者分叉；且 contentEditable 的 textContent 可能是
 *   整篇文档，必须封顶。走 router.dispatch 真跑生产代码，不复刻探针函数体。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/wait-actionable-auto-force.js", () => ({
  waitActionableAutoForce: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/native.js", () => ({
  pageQuery: async (
    _tid: number,
    _frameId: number | undefined,
    fn: (...a: unknown[]) => unknown,
    args: unknown[],
  ) => {
    const stripped = new Function(`return (${String(fn)})`)() as (...a: unknown[]) => unknown;
    return await Promise.resolve(stripped(...args));
  },
  mapPageError: (res: { error?: string }) => {
    throw new Error(res.error ?? "page error");
  },
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.TYPE, args, requestId: "r-type-value" } as NmRequest;
}

describe("TYPE 回读值", () => {
  let router: ActionRouter;
  let dom: JSDOM;
  let editor: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM(`<!DOCTYPE html><html><body><div id="ed"></div></body></html>`, {
      pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "InputEvent"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }
    editor = dom.window.document.getElementById("ed") as HTMLElement;
    // jsdom 不实现 isContentEditable（实测恒 undefined），不定义就走不到 CDP 分支
    Object.defineProperty(editor, "isContentEditable", { value: true, configurable: true });
    editor.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 200, height: 40, top: 10, bottom: 50, left: 10, right: 210 }) as DOMRect;

    win.__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
    };
    win.__vortexFillReject = { checkRejectPattern: () => ({ rejected: false }) };
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });

    router = new ActionRouter();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      // 模拟真实 insertText：不动 DOM 的话 verify 探针会读到未变化并报 NO_EFFECT
      sendCommand: vi.fn(async (_tid: number, method: string, params?: { text?: string }) => {
        if (method === "Input.insertText" && params?.text != null) {
          editor.textContent = (editor.textContent ?? "") + params.text;
        }
      }),
    };
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("成功返回带实读 value，而非入参字符数", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: "hello" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, typed: 5, value: "hello" });
  });

  it("编辑器改写内容时，返回的是实读值而非入参回声", async () => {
    // 编辑器把插入内容改掉（如自动补全/格式化）：只有真回读才拿得到改写后的值
    editor.textContent = "";
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: "raw" }));
    expect(resp.error).toBeUndefined();
    // 实读值来自 DOM，等于 mock 插入的结果
    expect((resp.result as { value: string }).value).toBe(editor.textContent);
  });

  it("超长内容截断到 500 字符并加省略号", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: "字".repeat(1200) }));
    const v = (resp.result as { value: string }).value;
    expect(v.length).toBe(501);              // 500 + "…"
    expect(v.endsWith("…")).toBe(true);
    expect(editor.textContent!.length).toBe(1200);  // DOM 里仍是完整内容，只有回传被截断
  });

  it("恰好 500 字符不截断、不加省略号", async () => {
    const exact = "x".repeat(500);
    const resp = await router.dispatch(mkReq({ selector: "#ed", text: exact }));
    expect((resp.result as { value: string }).value).toBe(exact);
  });
});
