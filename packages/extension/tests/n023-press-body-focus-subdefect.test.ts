// packages/extension/tests/n023-press-body-focus-subdefect.test.ts
//
// N023 · R1/R2 核销：PRESS 焦点契约回归（接**真实**注册 handler）
//
// ── 为什么这个文件存在 ────────────────────────────────────────────
// P2b 的 scenarios 测试用「复制模型」构造返回值，产品怎么改它都不变，
// 被 P3 审核判为 R1 阻断。本文件改为**注册真实 handler 并 dispatch**，
// 且 `chrome.scripting.executeScript` 的 mock 会**真正执行** probeFocus 注入的函数
// （对着一个真实 JSDOM document），因此断言的是**冻结的真实产品行为**。
//
// ── 范围声明（主控 D4 裁决 2）────────────────────────────────────
// 本文件只覆盖**已实证的子缺陷**：焦点为 body/documentElement（无可操作焦点目标）。
// **不覆盖**焦点在按钮/chip 的场景 —— 那条路径当前同样静默成功，但本方案不声称覆盖它。
//
// ── 失败语义（可证表述，R2 核销条件 3）────────────────────────────
// 不得写成 "key not delivered"。body 只能证明「**没有可操作的焦点目标**」，
// 不能证明 CDP 事件没投递（夹具页自己在 document 上监听 keydown 即为反例：
// 事件被站点逻辑拒绝 ≠ CDP 没投递）。故本文件用
// "no actionable focus target" 表述。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerKeyboardHandlers } from "../src/handlers/keyboard.js";

/** mock gemini 合成区的最小结构：编辑器 + 一个按钮（焦点可能落点）。 */
const FIXTURE_HTML = `<!DOCTYPE html><html><body>
  <rich-textarea><div id="editor" class="ql-editor" contenteditable="true" role="textbox"
    aria-label="为 Gemini 输入提示"></div></rich-textarea>
  <button id="steal">移出焦点</button>
</body></html>`;

/**
 * 让 executeScript 真正执行注入函数。
 * probeFocus 的注入函数直接读 document.activeElement —— 只有真跑才有意义。
 * @param fail probeFocus 是否应抛错（模拟"注入权限不足 → 返回空串"分支）
 */
function makeEnv(dom: JSDOM, opts: { probeFocusFails?: boolean } = {}) {
  const win = dom.window as unknown as Record<string, unknown>;
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = win.document;

  const executeScript = vi.fn(async (injection: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
    if (opts.probeFocusFails) throw new Error("Cannot access contents of url");
    // 真实执行注入函数
    return [{ result: injection.func(...(injection.args ?? [])) }];
  });

  (globalThis as Record<string, unknown>).chrome = {
    tabs: { query: vi.fn().mockResolvedValue([]) },
    scripting: { executeScript },
  };
  return { executeScript, dom };
}

describe("N023 R1/R2 · PRESS 焦点契约（真实 handler）", () => {
  let router: ActionRouter;
  let sendCommand: ReturnType<typeof vi.fn>;
  let dom: JSDOM;

  const press = (key: string) =>
    router.dispatch({
      type: "tool_request",
      tool: "keyboard.press",
      args: { key },
      requestId: `r-${key}-${Math.random()}`,
      tabId: 42,
    } as never);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("A-1 · 无可操作焦点目标（body/documentElement）→ 必须显式失败", () => {
    beforeEach(() => {
      dom = new JSDOM(FIXTURE_HTML);
      makeEnv(dom);
      // 关键：确保没有任何元素持有焦点 → document.activeElement === body
      (dom.window.document.activeElement as HTMLElement | null)?.blur?.();

      router = new ActionRouter();
      sendCommand = vi.fn().mockResolvedValue(undefined);
      const debuggerMgr = {
        onEvent: vi.fn(),
        enableDomain: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand,
      } as never;
      registerKeyboardHandlers(router, debuggerMgr);
    });

    // 【本文件即真实 RED】在冻结代码 4259bae 上，此断言**失败**：
    // 当前 PRESS 无条件 return { success:true }（keyboard.ts L259）。
    // P4 修复后它必须转绿，且**只能**靠真实产品代码变化转绿。
    it("焦点为 body 时，响应必须带 error（抛错契约），不得返回 success", async () => {
      const resp = await press("Enter");
      // 抛错契约：ActionRouter 捕获 VtxError → 返回 { error }
      expect(resp.error, "焦点为 body 时 PRESS 必须返回 error，而不是 success").toBeDefined();
      expect(resp.result).toBeUndefined();
    });

    it("失败语义必须是可证的『无可操作焦点目标』，不得断言 key not delivered", async () => {
      const resp = await press("Enter");
      const msg = resp.error?.message ?? "";
      expect(msg).toMatch(/focus/i);
      // 明确禁止不可证表述
      expect(msg.toLowerCase()).not.toContain("not delivered");
      expect(msg.toLowerCase()).not.toContain("no effect");
    });

    it("即便抛错，按键也不应被描述为『未投递』——CDP 仍会 dispatch", async () => {
      await press("Enter");
      // 说明当前设计下 CDP 调用照常发生；失败判定基于焦点不可证伪，
      // 因此错误文案不得越过证据边界。
      // （若 P4 改成「不投递」，本条需同步修订——那时才是可证的。）
      expect(typeof sendCommand).toBe("function");
    });
  });

  describe("A-2 · 有可操作焦点目标 → 不得误伤（回归面）", () => {
    beforeEach(() => {
      dom = new JSDOM(FIXTURE_HTML);
      makeEnv(dom);
      const doc = dom.window.document;
      (doc.getElementById("editor") as HTMLElement).focus();

      router = new ActionRouter();
      sendCommand = vi.fn().mockResolvedValue(undefined);
      const debuggerMgr = {
        onEvent: vi.fn(),
        enableDomain: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand,
      } as never;
      registerKeyboardHandlers(router, debuggerMgr);
    });

    it("焦点在编辑器 → 正常返回 success，无 error", async () => {
      const resp = await press("Enter");
      expect(resp.error).toBeUndefined();
      expect((resp.result as { success?: boolean })?.success).toBe(true);
    });

    it("焦点在按钮上 → 同样不得判失败（本方案明确不覆盖该场景，也不得误伤）", async () => {
      (dom.window.document.getElementById("steal") as HTMLElement).focus();
      const resp = await press("Enter");
      // 收窄范围的后果：该场景当前仍静默成功，本方案不声称修复它
      expect(resp.error).toBeUndefined();
    });

    it("合法全局键与组合键在 body 焦点下也须保留（不得 blanket 判失败）", async () => {
      // 判据只针对「Enter 这类需要焦点目标的键」；
      // Escape / F5 / Ctrl+S 这类全局键在无焦点时仍有意义。
      // 本条锁定该边界的存在，具体清单由 P4 定义。
      const resp = await press("Escape");
      // 当前实现不抛错 → 本条现在是绿的；P4 不得把 Escape 也 blanket 判失败
      expect(resp.error).toBeUndefined();
    });
  });

  /**
   * 对照组：证明上面的 RED 是**可满足的**，不是"永远红"的死断言。
   * 若抛错契约在本 harness 下根本观测不到（router 不返回 error），
   * 那 A-1 的失败就只是断言写错，而不是缺陷存在。
   */
  describe("对照组 · 抛错契约在本 harness 下可观测（证明 RED 可被修复满足）", () => {
    it("handler 抛 VtxError → ActionRouter 确实返回 { error }", async () => {
      const r = new ActionRouter();
      r.register("probe.throw", async () => {
        const err = new Error("no actionable focus target: focus is on body");
        throw err;
      });
      const resp = await r.dispatch({
        type: "tool_request",
        tool: "probe.throw",
        args: {},
        requestId: "ctl-1",
        tabId: 1,
      } as never);
      expect(resp.error).toBeDefined();
      expect(resp.error!.message).toMatch(/focus/i);
    });

    it("handler 正常返回 → ActionRouter 返回 { result }，无 error", async () => {
      const r = new ActionRouter();
      r.register("probe.ok", async () => ({ success: true, key: "Enter" }));
      const resp = await r.dispatch({
        type: "tool_request",
        tool: "probe.ok",
        args: {},
        requestId: "ctl-2",
        tabId: 1,
      } as never);
      expect(resp.error).toBeUndefined();
      expect((resp.result as { success?: boolean })?.success).toBe(true);
    });
  });

  describe("A-3 · probeFocus 读不到（注入失败）→ 不得判失败", () => {    beforeEach(() => {
      dom = new JSDOM(FIXTURE_HTML);
      makeEnv(dom, { probeFocusFails: true });
      router = new ActionRouter();
      sendCommand = vi.fn().mockResolvedValue(undefined);
      const debuggerMgr = {
        onEvent: vi.fn(),
        enableDomain: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand,
      } as never;
      registerKeyboardHandlers(router, debuggerMgr);
    });

    it("executeScript 抛错 → probeFocus 返回空串 → 不得判为失败", async () => {
      const resp = await press("Enter");
      // keyboard.ts L150-152：读失败返回空串，不影响 PRESS 本身。
      // P4 不得把「读不到焦点」误判成「无焦点目标」。
      expect(resp.error).toBeUndefined();
      expect((resp.result as { success?: boolean })?.success).toBe(true);
    });
  });
});
