import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxError, VtxErrorCode } from "@vortex-browser/shared";

/**
 * 诊断改进(2026-06-17 prodloop Round 1,example.com 原生 <dialog> live spike):
 * 原生 <dialog>.showModal() 打开时,浏览器把对话框外内容**隐式 inert**(不设 [inert]
 * 属性),且 modal 的 ::backdrop 归属 dialog 元素 → 背景元素 hit-test 命中 dialog →
 * actionability 报 OBSCURED → 重试到超时 → 抛 TIMEOUT "last reason: OBSCURED" + 泛化
 * hint「增大 timeout / wait_for idle」。
 *
 * 问题:对原生 modal dialog 场景该 hint **误导**——等待无用,正解是**关闭 dialog**。
 * R6 的 inert 诊断(lastReason=DISABLED + extras.inert)命中不了:原生 modal dialog
 * 既不设 [inert] 属性、reason 又是 OBSCURED 非 DISABLED。本修复是 R6 的另一半覆盖。
 *
 * 修复:actionability probe 在 OBSCURED 失败时用 `dialog:modal` 判据携 extras.modalBlocked;
 * waitActionable 超时抛错若 lastReason=OBSCURED 且 extras.modalBlocked → 消息追加关 dialog
 * 指引。本测试 mock checkActionability 锁住该消息构造行为(对齐 auto-wait-inert-hint.test.ts)。
 */

const checkActionability = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...args: unknown[]) => checkActionability(...args),
}));

const { waitActionable } = await import("../src/action/auto-wait.js");

describe("waitActionable: 原生 modal <dialog> 背景化 → OBSCURED 超时消息含关 dialog 指引", () => {
  beforeEach(() => checkActionability.mockReset());

  it("lastReason=OBSCURED + extras.modalBlocked → TIMEOUT 消息提示 modal/关闭 dialog", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "OBSCURED",
      extras: { blocker: "dialog#vtx-dlg", modalBlocked: true },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "#bg-btn", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VtxError);
    const ve = err as VtxError;
    // 2026-08-14:OBSCURED 不再压成 TIMEOUT —— TIMEOUT 的 hint 是「加大 timeout /
    // 等 idle」,对遮挡是死路(同 NOT_STABLE 先例:只改 hint 不改码,修复路径就是错的)。
    expect(ve.code).toBe(VtxErrorCode.OBSCURED);
    expect(ve.message).toMatch(/modal|dialog/i);
    // 指引须可 actionable:提示关闭 dialog/遮挡层
    expect(ve.message).toMatch(/dismiss|close|关闭|Escape/i);
  });

  it("普通 OBSCURED(非 modal,无 modalBlocked)→ 点名遮挡者，不追加关 dialog 指引", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "OBSCURED",
      extras: { blocker: "div.sticky-header" },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "#target", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.OBSCURED);
    // 门早就算出了压在上面的是谁,此前只进 context.extras —— 调用方看不到那里
    expect(ve.message).toContain("div.sticky-header");
    expect(ve.message).not.toMatch(/modal <dialog>|关闭 dialog/i);
  });

  it("modalBlocked=false(元素在 dialog 内)→ 不追加关 dialog 指引", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "OBSCURED",
      extras: { blocker: "span.overlay", modalBlocked: false },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "#in-dlg", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const ve = err as VtxError;
    expect(ve.message).not.toMatch(/dismiss the dialog/i);
  });

  it("hit-test 落空报「中心点没有元素」，不谎称被谁盖住", async () => {
    // blocker="elementFromPoint=null" 不是元素描述。按遮挡话术说，会把调用方
    // 推去找一个根本不存在的浮层（真因是被祖先裁剪或定位到视口外）。
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "OBSCURED",
      extras: { blocker: "elementFromPoint=null" },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "#clipped", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.OBSCURED);
    expect(ve.message).toMatch(/no element at all/i);
    expect(ve.message).not.toMatch(/covered by/i);
  });

  it("OBSCURED 的 hint 不再指向调用方看不到的 context.extras", async () => {
    // MCP 只渲染 message + hint;hint 让人去看 context.extras.blocker 等于没给。
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "OBSCURED",
      extras: { blocker: "div.pane" },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "#t", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const hint = (err as VtxError).extra?.hint ?? "";
    expect(hint).not.toMatch(/context\.extras/);
    expect(hint).toMatch(/dismiss|scroll away/i);
    // 也不能推荐 force:true —— live 实测它只跳过 actionability 门,合成 click 路径的
    // page-side 遮挡检查仍抛 ELEMENT_OCCLUDED。给一条走不通的出路比不给更坏。
    expect(hint).not.toMatch(/force/i);
  });

  it("非 OBSCURED 的超时仍是 TIMEOUT —— NOT_ATTACHED 走的是另一条兜底 hint", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_ATTACHED" });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "#gone", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.TIMEOUT);
    expect(ve.extra?.context?.extras).toMatchObject({ lastReason: "NOT_ATTACHED" });
  });
});
