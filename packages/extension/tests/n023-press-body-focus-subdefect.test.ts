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
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";

/** mock gemini 合成区的最小结构：编辑器 + 按钮 + 可聚焦附件 chip。 */
const FIXTURE_HTML = `<!DOCTYPE html><html><body>
  <rich-textarea><div id="editor" class="ql-editor" contenteditable="true" role="textbox"
    aria-label="为 Gemini 输入提示"></div></rich-textarea>
  <button id="steal">移出焦点</button>
  <div id="chip" class="chip" tabindex="0" role="button" aria-label="close n023-probe.txt">n023-probe</div>
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

    /**
     * 契约对齐：v6 入口冻结的是「**投递按键前**抛 vtxError」。
     * 因此目标键在 body 焦点下按契约应当**不派发**（dispatchKeyEvent 次数为 0）。
     * 保留键 / 组合键 / 正常路径才必须派发（见 A-2、A-2b）。
     */
    it("目标键在 body 焦点下依『投递前拒绝』语义不派发 CDP（派发次数为 0）", async () => {
      const before = sendCommand.mock.calls.length;
      await press("Enter");
      // 修复后：probeFocus 判定无焦点目标 → 抛错 → 不到 dispatchKey
      expect(sendCommand.mock.calls.length - before).toBe(0);
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
      expect(dom.window.document.activeElement?.id).toBe("editor"); // 输入状态先行
      const resp = await press("Enter");
      expect(resp.error).toBeUndefined();
      expect((resp.result as { success?: boolean })?.success).toBe(true);
    });

    it("焦点在按钮上 → 不得判失败（本方案不覆盖该场景，也不得误伤）", async () => {
      (dom.window.document.getElementById("steal") as HTMLElement).focus();
      expect(dom.window.document.activeElement?.id).toBe("steal");
      const resp = await press("Enter");
      expect(resp.error).toBeUndefined();
      expect((resp.result as { success?: boolean })?.success).toBe(true);
    });

    it("焦点在可聚焦附件 chip 上 → 不得判失败", async () => {
      const chip = dom.window.document.getElementById("chip") as HTMLElement;
      chip.focus();
      expect(dom.window.document.activeElement?.id).toBe("chip");
      const resp = await press("Enter");
      expect(resp.error).toBeUndefined();
      expect((resp.result as { success?: boolean })?.success).toBe(true);
    });
  });

  /**
   * A-2b · **真正的 body 焦点边界门禁**（R2 剩余核销点）
   *
   * 复审指出：旧用例名曰「body 焦点」，实际跑在编辑器焦点上，
   * 因此排除不了「只要 body 就对任何键抛错」的 blanket 实现。
   * 本组**独立于 A-2 的编辑器 beforeEach**，每条用例都先真实 blur 并断言输入状态。
   */
  describe("A-2b · body 焦点下保留键不得 blanket 判失败（真实 body 输入状态）", () => {
    beforeEach(() => {
      dom = new JSDOM(FIXTURE_HTML);
      makeEnv(dom);
      // 真实造出 body 焦点：先聚焦再 blur，activeElement 落回 body
      (dom.window.document.getElementById("editor") as HTMLElement).focus();
      (dom.window.document.activeElement as HTMLElement).blur();

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

    /** 断言当前确实是 body 焦点——标题不能替代输入状态。 */
    const expectBodyFocus = () => {
      expect(dom.window.document.activeElement).toBe(dom.window.document.body);
    };

    /**
     * 前置焦点取证。
     * 契约对齐：body + **目标键** 按契约必须返回 error 且 `result` 缺失，
     * 因此焦点取证**不能**依赖目标键的成功返回。
     * 此处改用**保留键 Escape** 读取真实 `focusedElement`（Escape 在 body 焦点下不判失败）。
     * press 前的真实 DOM body 检查（expectBodyFocus）保留。
     */
    it("前置：activeElement 确实是 body，且 probeFocus 对保留键返回 body 标识", async () => {
      expectBodyFocus();
      const resp = await press("Escape");
      // probeFocus 真实读到的就是 body 标识（不是模型标签）
      expect(resp.error).toBeUndefined();
      expect((resp.result as { focusedElement?: string })?.focusedElement)
        .toMatch(/body/i);
    });

    // ── 本批**目标键清单**（body 焦点下应当判失败）──────────────────
    // Enter / Space / Backspace / Delete：内容变更类键，作用于"当前焦点可编辑元素"；
    // body 持焦时不存在该元素，键无处可去。
    // 依据：Enter 有真实 E2E 证据（历史端到端记录 + A-1 真实 RED）；
    //      其余三键与 Enter 同机制（作用于焦点可编辑元素），在 v5 入口一并声明。
    it.each(["Enter", "Space", "Backspace", "Delete"])(
      "目标键 %s 在 body 焦点下应当判失败（内容变更类键无处可去）",
      async (key) => {
        expectBodyFocus();
        const resp = await press(key);
        // A-1 的判据：必须返回 error。当前冻结实现不抛 → 预期 RED
        expect(resp.error, `${key} 在 body 焦点下必须判失败`).toBeDefined();
      },
    );

    // ── 本批**保留键清单**（body 焦点下**不得**判失败）────────────────
    // 全局/浏览器级键与组合键：语义不依赖可编辑焦点。
    it.each(["Escape", "F5", "F12", "Tab"])(
      "保留键 %s 在 body 焦点下不得判失败（全局/焦点导航类语义）",
      async (key) => {
        expectBodyFocus();
        const before = sendCommand.mock.calls.length;
        const resp = await press(key);
        // 三项断言：无 error / success:true / CDP 派发确实发生
        expect(resp.error, `${key} 不得被 blanket 判失败`).toBeUndefined();
        expect((resp.result as { success?: boolean })?.success).toBe(true);
        expect(sendCommand.mock.calls.length).toBeGreaterThan(before);
        expect(sendCommand.mock.calls.map((c) => c[1])).toContain("Input.dispatchKeyEvent");
      },
    );

    // 组合键必须**真的 press**（旧用例只留标题、没执行）
    it.each(["Ctrl+s", "Meta+a", "Shift+Tab"])(
      "组合键 %s 在 body 焦点下不得判失败，且必须真的派发",
      async (combo) => {
        expectBodyFocus();
        const before = sendCommand.mock.calls.length;
        const resp = await press(combo);
        expect(resp.error, `${combo} 不得被 blanket 判失败`).toBeUndefined();
        expect((resp.result as { success?: boolean })?.success).toBe(true);
        // 组合键至少两次派发（普通单键本身就有 keyDown/keyUp 两次，
        // 故本条只证明"确实派发了多次"，不单独用来证明修饰位——
        // 修饰位由既有 keyboard-press-combos 回归覆盖）
        const modCalls = sendCommand.mock.calls
          .slice(before)
          .filter((c) => c[1] === "Input.dispatchKeyEvent");
        expect(modCalls.length).toBeGreaterThanOrEqual(2);
      },
    );

    /**
     * 契约对齐：目标键依「投递前拒绝」语义**不派发**（与保留键/组合键相反）。
     * 修复后 body+Enter 走 probeFocus → 抛错 → 不到 dispatchKey。
     * 当前冻结实现无条件派发 → 本条为预期 RED。
     */
    it("目标键 Enter 在 body 焦点下依『投递前拒绝』不派发 CDP", async () => {
      expectBodyFocus();
      const before = sendCommand.mock.calls.length;
      await press("Enter");
      expect(sendCommand.mock.calls.length - before).toBe(0);
    });
  });

  /**
   * 对照组：证明上面的 RED 是**可满足的**，不是"永远红"的死断言。
   * 若抛错契约在本 harness 下根本观测不到（router 不返回 error），
   * 那 A-1 的失败就只是断言写错，而不是缺陷存在。
   */
  describe("对照组 · 抛错契约在本 harness 下可观测（证明 RED 可被修复满足）", () => {
    it("handler 抛真实 VtxError → ActionRouter 走 toJSON 分支返回 { error } 且无 result", async () => {
      const r = new ActionRouter();
      r.register("probe.throw", async () => {
        // 用真实的 vtxError（不是 new Error），走 router.ts 的 VtxError 优先分支
        throw vtxError(VtxErrorCode.INVALID_PARAMS, "no actionable focus target: focus is on body");
      });
      const resp = await r.dispatch({
        type: "tool_request",
        tool: "probe.throw",
        args: {},
        requestId: "ctl-1",
        tabId: 1,
      } as never);
      expect(resp.error).toBeDefined();
      // 真实 VtxError 会带 code，且 toJSON() 分支保证 result 缺失
      expect(resp.error!.code).toBe(VtxErrorCode.INVALID_PARAMS);
      expect(resp.error!.message).toMatch(/focus/i);
      expect(resp.result).toBeUndefined();
    });

    it("handler 抛普通 Error → 走兜底分支也返回 { error }（code 为推断值）", async () => {
      const r = new ActionRouter();
      r.register("probe.throwPlain", async () => {
        throw new Error("no actionable focus target: focus is on body");
      });
      const resp = await r.dispatch({
        type: "tool_request",
        tool: "probe.throwPlain",
        args: {},
        requestId: "ctl-1b",
        tabId: 1,
      } as never);
      expect(resp.error).toBeDefined();
      // 兜底分支按 message 粗粒度推断 code，不是 INVALID_PARAMS
      expect(resp.error!.code).not.toBe(VtxErrorCode.INVALID_PARAMS);
      expect(resp.error!.code).toBe(VtxErrorCode.JS_EXECUTION_ERROR);
      expect(resp.result).toBeUndefined();
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
