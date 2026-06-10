/**
 * Author: qingwa
 * Description: FILL/TYPE CDP-first 写入机制转正契约（2026-06-11,spike 报告 reports/spike-cdp/）。
 *
 * 转正:fill/type 默认走 CDP Input.insertText(isTrusted=true),对齐 playwright-mcp/
 *   chrome-devtools-mcp/Stagehand。value-setter / page-side-dispatch 降为 forceSynthetic
 *   + CDP attach 失败的降级路径(族 F 受控绕过/逐字保真保留)。分流启发式(fill-reject /
 *   族 B 类型分流)照旧前置,对两条写入路径都生效。
 *
 * 测试方式:pageQuery 真执行 inline func(jsdom);debuggerMgr.sendCommand 模拟
 *   Input.insertText 在 activeElement 选区处插入(浏览器真实语义)——只有 handler 先
 *   全选,结果才是「替换」,从而行为级验证 select-all 契约(见 vortex_test_pageside_pure_fn)。
 *
 * 契约:
 *   F1. 默认 → attach + insertText(替换非拼接),path="cdp-insertText"
 *   F2. 默认仍跑 fill-reject 探测(转正:分流照旧,与 spike 实验「跳过」相反)
 *   F3. CDP readback 空 → NO_EFFECT(族 A)
 *   F4. forceSynthetic=true → value-setter,不碰 CDP
 *   F5. 仍过 actionability 门
 *   F6. CDP attach 失败 → 降级 value-setter(写值成功)
 *   F7. 类型分流(<select>/checkbox/contenteditable)→ INVALID_TARGET(族 B,CDP 路径前置)
 *   T1. 默认 input → CDP insertText 替换,path="cdp-insertText"
 *   T2. contentEditable → CDP insertText(path="cdp-insertText")
 *   T3. forceSynthetic=true → page-side-dispatch,不碰 CDP
 *   T4. CDP attach 失败(input)→ 降级 page-side-dispatch
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { VtxErrorCode, DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

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

describe("FILL/TYPE CDP-first 写入机制转正", () => {
  let router: ActionRouter;
  let dom: JSDOM;
  let debuggerMgr: { attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };
  let insertTextImpl: (text: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    executedFuncSources.length = 0;
    dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <input id="kw" value="OLD" />
        <textarea id="ta">OLD</textarea>
        <div id="rich" contenteditable="true">OLD</div>
        <select id="sel"><option value="a">A</option></select>
        <input id="cb" type="checkbox" />
      </body></html>`,
      { pretendToBeVisual: true },
    );
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "KeyboardEvent", "InputEvent", "Event"]) {
      (globalThis as Record<string, unknown>)[g] = (dom.window as unknown as Record<string, unknown>)[g];
    }
    (dom.window as unknown as Record<string, unknown>).__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
      deepElementFromPoint: () => null,
    };
    (dom.window as unknown as Record<string, unknown>).__vortexFillReject = {
      checkRejectPattern: () => ({ rejected: false }),
    };
    Object.defineProperty(dom.window.document.getElementById("rich")!, "isContentEditable", {
      value: true,
      configurable: true,
    });
    for (const id of ["kw", "ta", "rich", "sel", "cb"]) {
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

  // ---- FILL ----

  it("F1: 默认 → attach + Input.insertText,预填值被替换非拼接,path=cdp-insertText", async () => {
    const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#kw", value: "NEW" }));
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.attach).toHaveBeenCalledWith(1);
    expect(debuggerMgr.sendCommand).toHaveBeenCalledWith(1, "Input.insertText", { text: "NEW" });
    expect((dom.window.document.getElementById("kw") as HTMLInputElement).value).toBe("NEW");
    expect((resp.result as { path?: string }).path).toBe("cdp-insertText");
  });

  it("F2: 默认仍跑 fill-reject 探测(分流照旧)", async () => {
    await router.dispatch(mkReq(DomActions.FILL, { selector: "#kw", value: "NEW" }));
    expect(executedFuncSources.some((s) => s.includes("__vortexFillReject"))).toBe(true);
  });

  it("F3: CDP readback 空 → NO_EFFECT(族 A)", async () => {
    insertTextImpl = () => {
      (dom.window.document.getElementById("kw") as HTMLInputElement).value = "";
    };
    const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#kw", value: "abc" }));
    expect(resp.error?.code).toBe(VtxErrorCode.NO_EFFECT);
  });

  it("F4: forceSynthetic=true → value-setter,不碰 CDP", async () => {
    const resp = await router.dispatch(
      mkReq(DomActions.FILL, { selector: "#kw", value: "NEW", forceSynthetic: true }),
    );
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
    expect((dom.window.document.getElementById("kw") as HTMLInputElement).value).toBe("NEW");
  });

  it("F5: 仍过 actionability 门", async () => {
    await router.dispatch(mkReq(DomActions.FILL, { selector: "#kw", value: "NEW" }));
    expect(waitActionableMock).toHaveBeenCalled();
  });

  it("F6: CDP attach 失败 → 降级 value-setter 写值成功", async () => {
    debuggerMgr.attach.mockRejectedValue(new Error("Another debugger is already attached"));
    const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#kw", value: "NEW" }));
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
    expect((dom.window.document.getElementById("kw") as HTMLInputElement).value).toBe("NEW");
  });

  it("F7a: <select> → INVALID_TARGET(族 B 类型分流,CDP 前置)", async () => {
    const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#sel", value: "a" }));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_TARGET);
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
  });

  it("F7b: checkbox → INVALID_TARGET", async () => {
    const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#cb", value: "x" }));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_TARGET);
  });

  it("F7c: contentEditable → INVALID_TARGET(指引改用 type)", async () => {
    const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#rich", value: "x" }));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_TARGET);
  });

  // ---- TYPE ----

  it("T1: 默认 input → CDP insertText 替换,path=cdp-insertText", async () => {
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#kw", text: "NEW" }));
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.sendCommand).toHaveBeenCalledWith(1, "Input.insertText", { text: "NEW" });
    expect((dom.window.document.getElementById("kw") as HTMLInputElement).value).toBe("NEW");
    expect((resp.result as { path?: string }).path).toBe("cdp-insertText");
  });

  it("T2: contentEditable → CDP insertText(path=cdp-insertText)", async () => {
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#rich", text: "NEW" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { path?: string }).path).toBe("cdp-insertText");
    expect(debuggerMgr.sendCommand).toHaveBeenCalledWith(1, "Input.insertText", { text: "NEW" });
  });

  it("T3: forceSynthetic=true → page-side-dispatch,不碰 CDP", async () => {
    const resp = await router.dispatch(
      mkReq(DomActions.TYPE, { selector: "#kw", text: "NEW", forceSynthetic: true }),
    );
    expect(resp.error).toBeUndefined();
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
    expect((resp.result as { path?: string }).path).toBe("page-side-dispatch");
  });

  it("T4: CDP attach 失败(input)→ 降级 page-side-dispatch", async () => {
    debuggerMgr.attach.mockRejectedValue(new Error("Cannot attach to this target"));
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#kw", text: "NEW" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { path?: string }).path).toBe("page-side-dispatch");
    expect((dom.window.document.getElementById("kw") as HTMLInputElement).value).toBe("NEW");
  });
});
