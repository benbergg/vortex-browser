import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxError, VtxErrorCode } from "@vortex-browser/shared";

/**
 * 诊断改进(2026-06-17 Booking.com dogfood):页面加载即弹 modal 并给背景内容打 [inert]
 * (极常见真实模式)时,背景表单元素 isEnabledElement=false → actionability 报 DISABLED →
 * 重试到超时 → 抛 TIMEOUT "last reason: DISABLED" + 泛化 hint「增大 timeout / wait_for idle」。
 *
 * 问题:对 inert/modal 场景该 hint **误导**——等待无用,正解是**关闭遮挡层(modal/overlay)**。
 * vortex 行为正确(拒绝写 inert 元素,非缺陷),但诊断不可 actionable。
 *
 * 修复:actionability probe 在 DISABLED 失败时区分 inert(extras.inert),waitActionable
 * 超时抛错时若 lastReason=DISABLED 且 extras.inert → 消息追加「元素处于 inert 子树(常见于
 * modal/overlay 背景),先关闭遮挡层再重试」。本测试 mock checkActionability 锁住该行为。
 */

const checkActionability = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...args: unknown[]) => checkActionability(...args),
}));

const { waitActionable } = await import("../src/action/auto-wait.js");

describe("waitActionable: inert(modal 背景化)→ DISABLED 超时消息含关遮挡指引", () => {
  beforeEach(() => checkActionability.mockReset());

  it("lastReason=DISABLED + extras.inert → TIMEOUT 消息提示 inert/关闭遮挡层", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "DISABLED",
      extras: { inert: true },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, 'input[name="ss"]', { timeout: 120 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VtxError);
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.TIMEOUT);
    expect(ve.message).toMatch(/inert/i);
    // 指引须可 actionable:提示关闭 modal/overlay/遮挡层
    expect(ve.message).toMatch(/modal|overlay|遮挡|dismiss|关闭/i);
  });

  it("普通 DISABLED(非 inert)→ 不追加关遮挡指引(避免误导原生 disabled 控件)", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "DISABLED",
      extras: { inert: false },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "#submit", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.TIMEOUT);
    expect(ve.message).not.toMatch(/inert/i);
  });
});
