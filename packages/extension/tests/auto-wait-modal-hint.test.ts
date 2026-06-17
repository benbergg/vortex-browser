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
    expect(ve.code).toBe(VtxErrorCode.TIMEOUT);
    expect(ve.message).toMatch(/modal|dialog/i);
    // 指引须可 actionable:提示关闭 dialog/遮挡层
    expect(ve.message).toMatch(/dismiss|close|关闭|Escape/i);
  });

  it("普通 OBSCURED(非 modal,无 modalBlocked)→ 不追加关 dialog 指引(避免误导真遮挡)", async () => {
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
    expect(ve.code).toBe(VtxErrorCode.TIMEOUT);
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
});
