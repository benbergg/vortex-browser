/**
 * Author: qingwa
 * Description: 隐藏输入代理(hidden helper input)放行与批量键入契约。
 *   xterm.js / Monaco 这类控件把真正的输入落在「小尺寸 + 刻意移出视口 + 可聚焦」的
 *   input/textarea 上：它们的工作方式就是移出视口（实测 xterm helper textarea 在
 *   x=-133320）。旧的可见性闸门对它们一律报 ELEMENT_OFFSCREEN，agent 无法输命令。
 *
 *   覆盖四件事：
 *   1) type 支持隐藏输入代理；终端代理的 fill 明确拒绝；
 *   2) type 走 CDP 受信任按键（终端类控件只认 keydown，合成事件进不了 pty）；
 *   3) 放行范围保守：普通尺寸的离屏元素仍然报 ELEMENT_OFFSCREEN，可见输入行为不变；
 *   4) 几何条件不足以判定「代理」：同样形状的隐藏输入若不在编辑器/终端宿主容器内
 *      （蜜罐、页面自带的隐藏表单控件），仍然报 ELEMENT_OFFSCREEN；
 *   5) 宿主容器不是通行证：同在 .xterm 内的 disabled/readonly 输入仍被拒。
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

function mkReq(tool: string, args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-hidden-helper" } as NmRequest;
}

/** 视口内普通输入框 */
const VISIBLE_RECT = { x: 10, y: 10, width: 200, height: 40, top: 10, bottom: 50, left: 10, right: 210 };
/** 隐藏输入代理：1x1，刻意移到视口左侧之外（xterm helper textarea 实测形状） */
const HELPER_RECT = { x: -133320, y: 0, width: 1, height: 1, top: 0, bottom: 1, left: -133320, right: -133319 };
/** 普通尺寸但离屏：不该被放行 */
const BIG_OFFSCREEN_RECT = { x: -133320, y: 0, width: 200, height: 40, top: 0, bottom: 40, left: -133320, right: -133120 };

describe("隐藏输入代理放行 + 批量键入", () => {
  let router: ActionRouter;
  let dom: JSDOM;
  let sendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="xterm"><textarea class="xterm-helper-textarea" id="helper"></textarea></div>
         <div class="xterm"><textarea id="helper-disabled" disabled></textarea></div>
         <div class="xterm"><textarea id="helper-readonly" readonly></textarea></div>
         <div class="monaco-editor"><textarea id="helper-mono"></textarea></div>
         <textarea id="honeypot"></textarea>
         <input id="offscreen" />
         <input id="visible" />
       </body></html>`,
      { pretendToBeVisual: true },
    );
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "InputEvent", "KeyboardEvent"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }
    const doc = dom.window.document;
    (doc.getElementById("helper") as HTMLElement).getBoundingClientRect = () => HELPER_RECT as DOMRect;
    (doc.getElementById("helper-disabled") as HTMLElement).getBoundingClientRect = () => HELPER_RECT as DOMRect;
    (doc.getElementById("helper-readonly") as HTMLElement).getBoundingClientRect = () => HELPER_RECT as DOMRect;
    (doc.getElementById("helper-mono") as HTMLElement).getBoundingClientRect = () => HELPER_RECT as DOMRect;
    (doc.getElementById("honeypot") as HTMLElement).getBoundingClientRect = () => HELPER_RECT as DOMRect;
    (doc.getElementById("offscreen") as HTMLElement).getBoundingClientRect = () => BIG_OFFSCREEN_RECT as DOMRect;
    (doc.getElementById("visible") as HTMLElement).getBoundingClientRect = () => VISIBLE_RECT as DOMRect;

    win.__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(doc.querySelectorAll(sel)),
      isEnabled: () => true,
    };
    win.__vortexFillReject = { checkRejectPattern: () => ({ rejected: false }) };
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });

    router = new ActionRouter();
    sendCommand = vi.fn().mockResolvedValue(undefined);
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand,
    };
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("type 到隐藏输入代理不再报 ELEMENT_OFFSCREEN，且走 CDP 受信任按键", async () => {
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#helper", text: "ls" }));
    expect(resp.error).toBeUndefined();
    // 走 CDP 按键路径：终端类控件只认 keydown，合成事件进不了 pty
    expect(resp.result).toMatchObject({ success: true, path: "cdp-keys", typed: 2 });
    const keyDowns = sendCommand.mock.calls.filter(
      (c: unknown[]) => c[1] === "Input.dispatchKeyEvent" && (c[2] as { type?: string })?.type === "keyDown",
    );
    // 整串一次送出：两个字符 = 两个 keyDown，且都带 text（页面收到的是真按键输入）
    expect(keyDowns.map((c: unknown[]) => (c[2] as { text?: string }).text)).toEqual(["l", "s"]);
  });

  it("type 到隐藏输入代理时先聚焦它（preventScroll，避免把页面滚到离屏坐标）", async () => {
    const helper = dom.window.document.getElementById("helper") as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(helper, "focus");
    await router.dispatch(mkReq(DomActions.TYPE, { selector: "#helper", text: "ls" }));
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(dom.window.document.activeElement).toBe(helper);
  });

  it("焦点被页面转移时拒绝终端键入", async () => {
    const helper = dom.window.document.getElementById("helper") as HTMLTextAreaElement;
    vi.spyOn(helper, "focus").mockImplementation(() => {});
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#helper", text: "ls" }));
    expect(resp.error).toBeDefined();
    expect(sendCommand.mock.calls.filter((c: unknown[]) => c[1] === "Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("fill 拒绝终端输入代理且不修改已有输入", async () => {
    const helper = dom.window.document.getElementById("helper") as HTMLTextAreaElement;
    helper.value = "existing";
    for (const value of ["whoami", ""]) {
      const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#helper", value }));
      expect(resp.error).toBeDefined();
      expect((resp.error as { message: string }).message).toMatch(/type|press/i);
      expect(helper.value).toBe("existing");
    }
  });

  it("视口内终端输入代理的 fill 也拒绝且没有副作用", async () => {
    const helper = dom.window.document.getElementById("helper") as HTMLTextAreaElement;
    helper.getBoundingClientRect = () => ({ ...VISIBLE_RECT, width: 1, height: 1, right: 11, bottom: 11 }) as DOMRect;
    helper.focus();
    helper.value = "pending";
    const onInput = vi.fn();
    helper.addEventListener("input", onInput);
    for (const value of ["whoami", ""]) {
      const resp = await router.dispatch(mkReq(DomActions.FILL, { selector: "#helper", value }));
      expect(resp.error).toBeDefined();
      expect(helper.value).toBe("pending");
      expect(onInput).not.toHaveBeenCalled();
    }
  });

  it("普通尺寸的离屏输入仍然报 ELEMENT_OFFSCREEN（放行范围保守）", async () => {
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#offscreen", text: "x" }));
    expect((resp.error as { message: string }).message).toContain("outside the viewport");
  });

  it("形状相同但不在编辑器/终端宿主内的隐藏输入仍被拒（蜜罐不放行）", async () => {
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#honeypot", text: "x" }));
    expect((resp.error as { message: string }).message).toContain("outside the viewport");
  });

  it("宿主容器内的 disabled/readonly 隐藏输入仍被拒（宿主选择器不是通行证）", async () => {
    const dis = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#helper-disabled", text: "x" }));
    expect(dis.error).toBeDefined();
    const ro = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#helper-readonly", text: "x" }));
    expect(ro.error).toBeDefined();
  });

  it("编辑器家族容器内的隐藏输入代理放行（不只 .xterm）", async () => {
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#helper-mono", text: "ls" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, path: "cdp-keys" });
  });

  it("可见输入框行为不变：仍走 page-side 合成派发", async () => {
    const resp = await router.dispatch(mkReq(DomActions.TYPE, { selector: "#visible", text: "hi" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { path?: string }).path).toBe("page-side-dispatch");
    // 合成派发路径不发 CDP 按键
    expect(sendCommand.mock.calls.filter((c: unknown[]) => c[1] === "Input.dispatchKeyEvent")).toHaveLength(0);
  });
});
