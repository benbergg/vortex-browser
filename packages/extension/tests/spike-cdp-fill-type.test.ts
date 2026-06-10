/**
 * Author: qingwa
 * Description: spike(cdp-first 阶段0) — FILL/TYPE 的 CDP Input.insertText 实验分支。
 *
 * 背景:对标 playwright-mcp / chrome-devtools-mcp / Stagehand,三家 fill/type 全程
 *   CDP Input(isTrusted=true),vortex 默认 value-setter/合成 dispatch。本实验分支
 *   由 args.cdpFill / args.cdpType 开启,供 bench compare-cdp 双模式对比,不改默认。
 *
 * 测试方式:pageQuery mock 真执行 page-side inline func(jsdom 全局,避免源码 regex
 *   假覆盖,见 vortex_test_pageside_pure_fn 教训);debuggerMgr.sendCommand 模拟
 *   Input.insertText 的浏览器语义——在 activeElement 的**光标/选区处**插入:
 *   只有 handler 先全选,结果才是「替换」;不全选会得到 "旧值新值" 拼接,从而
 *   行为级验证 select-all 契约。
 *
 * 契约:
 *   F1. cdpFill=true:attach + Input.insertText(text=value),预填 "OLD" 后结果为
 *       value(替换非拼接),result.path="cdp-fill-insertText"
 *   F2. cdpFill=true 跳过 fill-reject 探测(实验变量:验证启发式在真实输入下是否仍必要)
 *   F3. cdpFill=true readback 校验:非空 value 读回空 → NO_EFFECT(族 A 处方)
 *   F4. 默认(无 cdpFill):行为不变,不碰 CDP
 *   F5. cdpFill 仍过 actionability 门(waitActionable 被调用,门不绕过)
 *   T1. cdpType=true(input/textarea):insertText 替换写入,path="cdp-type-insertText"
 *   T2. 默认(无 cdpType):input 走 page-side-dispatch,不碰 CDP
 *   T3. contentEditable 元素 cdpType=true:仍走原 contentEditable 分支(path=
 *       "cdp-insertText",不双跑实验分支)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { VtxErrorCode, DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

// actionability 门 mock:默认放行,F5 断言它被调用
const waitActionableMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: (...args: unknown[]) => waitActionableMock(...args),
}));

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

// pageQuery 真执行 inline func(jsdom 全局);记录每次调用的 func 源码供 F2 断言。
const executedFuncSources: string[] = [];
vi.mock("../src/adapter/native.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pageQuery: vi.fn(
      async (
        _tabId: number,
        _frameId: number | undefined,
        func: (...a: unknown[]) => unknown,
        args?: unknown[],
      ) => {
        executedFuncSources.push(String(func));
        return await Promise.resolve(func(...(args ?? [])));
      },
    ),
  };
});

function mkReq(tool: string, args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1" } as NmRequest;
}

/** 模拟 CDP Input.insertText:在 activeElement 的选区处插入(浏览器真实语义)。 */
function simulateInsertText(doc: Document, text: string): void {
  const el = doc.activeElement as HTMLInputElement | null;
  if (!el || typeof el.value !== "string") return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
}

describe("spike(cdp-first): FILL cdpFill / TYPE cdpType 实验分支", () => {
  let router: ActionRouter;
  let dom: JSDOM;
  let debuggerMgr: { attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };
  /** sendCommand 的 insertText 行为可被单测覆盖(F3 模拟拒绝输入) */
  let insertTextImpl: (text: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    executedFuncSources.length = 0;
    dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <input id="kw" value="OLD" />
        <div id="rich" contenteditable="true">OLD</div>
      </body></html>`,
      { pretendToBeVisual: true },
    );
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as unknown as Record<string, unknown>).HTMLInputElement = dom.window.HTMLInputElement;
    (globalThis as unknown as Record<string, unknown>).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
    (globalThis as unknown as Record<string, unknown>).HTMLSelectElement = dom.window.HTMLSelectElement;
    (globalThis as unknown as Record<string, unknown>).KeyboardEvent = dom.window.KeyboardEvent;
    (globalThis as unknown as Record<string, unknown>).InputEvent = dom.window.InputEvent;
    (globalThis as unknown as Record<string, unknown>).Event = dom.window.Event;

    // page-side 模块 stub(loadPageSideModule 被 mock,inline func 引用的全局对象手工提供)
    (dom.window as unknown as Record<string, unknown>).__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
    };

    // jsdom 不实现 isContentEditable(恒 undefined),probe 的 contentEditable 检测需手工补
    Object.defineProperty(dom.window.document.getElementById("rich")!, "isContentEditable", {
      value: true,
      configurable: true,
    });

    // jsdom getBoundingClientRect 恒 0×0,probe 的零尺寸/视口检查需要真实 rect
    for (const id of ["kw", "rich"]) {
      const el = dom.window.document.getElementById(id)!;
      el.getBoundingClientRect = () =>
        ({ x: 10, y: 10, width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }) as DOMRect;
    }

    insertTextImpl = (text: string) => simulateInsertText(dom.window.document, text);
    debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_tabId: number, method: string, params: { text?: string }) => {
        if (method === "Input.insertText") insertTextImpl(params.text ?? "");
      }),
    };
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("F1: cdpFill=true → attach + Input.insertText,预填值被替换非拼接", async () => {
    const resp = await router.dispatch(
      mkReq(DomActions.FILL, { selector: "#kw", value: "NEW", cdpFill: true }),
    );
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.attach).toHaveBeenCalledWith(1);
    expect(debuggerMgr.sendCommand).toHaveBeenCalledWith(1, "Input.insertText", { text: "NEW" });
    const el = dom.window.document.getElementById("kw") as HTMLInputElement;
    expect(el.value).toBe("NEW"); // 不是 "OLDNEW" —— select-all 替换语义
    expect((resp.result as { path?: string }).path).toBe("cdp-fill-insertText");
  });

  it("F2: cdpFill=true 跳过 fill-reject 探测", async () => {
    await router.dispatch(
      mkReq(DomActions.FILL, { selector: "#kw", value: "NEW", cdpFill: true }),
    );
    expect(executedFuncSources.some((s) => s.includes("__vortexFillReject"))).toBe(false);
  });

  it("F3: cdpFill=true readback 空值 → NO_EFFECT(模拟 type 约束拒绝输入)", async () => {
    insertTextImpl = () => {
      const el = dom.window.document.getElementById("kw") as HTMLInputElement;
      el.value = ""; // 模拟 number/date 约束:insertText 被原生拒绝置空
    };
    const resp = await router.dispatch(
      mkReq(DomActions.FILL, { selector: "#kw", value: "abc", cdpFill: true }),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.NO_EFFECT);
  });

  it("F4: 默认(无 cdpFill)走 value-setter 路径,不碰 CDP", async () => {
    // 默认路径会跑 fill-reject inline func,其引用 window.__vortexFillReject —— stub 放行
    (dom.window as unknown as Record<string, unknown>).__vortexFillReject = {
      checkRejectPattern: () => ({ rejected: false }),
    };
    const resp = await router.dispatch(
      mkReq(DomActions.FILL, { selector: "#kw", value: "NEW" }),
    );
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
    const el = dom.window.document.getElementById("kw") as HTMLInputElement;
    expect(el.value).toBe("NEW");
  });

  it("F5: cdpFill=true 仍过 actionability 门(不绕 waitActionable)", async () => {
    await router.dispatch(
      mkReq(DomActions.FILL, { selector: "#kw", value: "NEW", cdpFill: true }),
    );
    expect(waitActionableMock).toHaveBeenCalled();
  });

  it("T1: cdpType=true(input)→ insertText 替换写入,path=cdp-type-insertText", async () => {
    const resp = await router.dispatch(
      mkReq(DomActions.TYPE, { selector: "#kw", text: "NEW", cdpType: true }),
    );
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.sendCommand).toHaveBeenCalledWith(1, "Input.insertText", { text: "NEW" });
    const el = dom.window.document.getElementById("kw") as HTMLInputElement;
    expect(el.value).toBe("NEW"); // 替换非拼接
    expect((resp.result as { path?: string }).path).toBe("cdp-type-insertText");
  });

  it("T2: 默认(无 cdpType)input 走 page-side-dispatch,不碰 CDP", async () => {
    const resp = await router.dispatch(
      mkReq(DomActions.TYPE, { selector: "#kw", text: "NEW" }),
    );
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
    expect((resp.result as { path?: string }).path).toBe("page-side-dispatch");
  });

  it("T3: contentEditable + cdpType=true → 仍走原 contentEditable 分支(不双跑)", async () => {
    const resp = await router.dispatch(
      mkReq(DomActions.TYPE, { selector: "#rich", text: "NEW", cdpType: true }),
    );
    expect(resp.error).toBeUndefined();
    expect((resp.result as { path?: string }).path).toBe("cdp-insertText");
    // contentEditable 分支只 insertText 一次(无实验分支的二次 readback/select 调用)
    expect(debuggerMgr.sendCommand).toHaveBeenCalledTimes(1);
  });
});
