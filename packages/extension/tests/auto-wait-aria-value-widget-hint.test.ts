import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxError, VtxErrorCode } from "@vortex-browser/shared";

/**
 * 诊断改进(2026-06-22 radix-ui slider dogfood):对 ARIA value 控件
 * (role=slider/spinbutton,div-based 如 Radix Primitives / APG)调 vortex_fill 时,
 * actionability 正确报 NOT_EDITABLE(它们非 input,确实不可填——vortex 行为正确),
 * 但通用 NOT_EDITABLE hint「pick a different selector that points to an actual input」
 * 对这类控件**误导**:它们根本无可填 input,正解是键盘(Arrow/Home/End)或 drag 设值。
 *
 * 实测:Radix slider span[role=slider] 经 vortex_press ArrowRight 50→51、
 * vortex_mouse_drag 50→80 均生效,fill 则 NOT_EDITABLE。
 *
 * 修复:page-side actionability 在 NOT_EDITABLE 时检测 role=slider/spinbutton 携带
 * extras.ariaValueWidget;auto-wait 立即抛错时据此定制 message 指向键盘/drag(沿用
 * inertBlocked/modalBlocked 经 extras 定制 message 的既有模式)。本测试 mock
 * checkActionability 锁住该行为。
 */

const checkActionability = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...args: unknown[]) => checkActionability(...args),
}));

const { waitActionable } = await import("../src/action/auto-wait.js");

describe("waitActionable: ARIA value 控件 NOT_EDITABLE → 消息指向键盘/drag 而非 input", () => {
  beforeEach(() => checkActionability.mockReset());

  it("role=slider + extras.ariaValueWidget → NOT_EDITABLE 消息含键盘/drag 指引、不再让找 input", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "NOT_EDITABLE",
      extras: { tagName: "span", hasReadOnly: false, ariaValueWidget: "slider" },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, 'span[aria-label="Volume"]', { timeout: 120 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VtxError);
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.NOT_EDITABLE);
    // 指明是 ARIA value 控件且无 input
    expect(ve.message).toMatch(/slider/);
    expect(ve.message).toMatch(/ARIA value widget|no fillable input/i);
    // 给出可 actionable 的键盘/drag 路径
    expect(ve.message).toMatch(/vortex_press/);
    expect(ve.message).toMatch(/vortex_mouse_drag|drag/);
  });

  it("role=spinbutton 同样命中定制指引", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "NOT_EDITABLE",
      extras: { tagName: "div", hasReadOnly: false, ariaValueWidget: "spinbutton" },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "div[role=spinbutton]", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.NOT_EDITABLE);
    expect(ve.message).toMatch(/spinbutton/);
    expect(ve.message).toMatch(/vortex_press/);
  });

  it("普通 NOT_EDITABLE(非 ARIA value 控件)→ 保持通用消息,不误导键盘/drag", async () => {
    checkActionability.mockResolvedValue({
      ok: false,
      reason: "NOT_EDITABLE",
      extras: { tagName: "div", hasReadOnly: false, ariaValueWidget: undefined },
    });
    let err: unknown;
    try {
      await waitActionable(42, undefined, "div.label", { timeout: 120 });
    } catch (e) {
      err = e;
    }
    const ve = err as VtxError;
    expect(ve.code).toBe(VtxErrorCode.NOT_EDITABLE);
    expect(ve.message).toBe('NOT_EDITABLE on selector "div.label"');
    expect(ve.message).not.toMatch(/vortex_press|slider/);
  });
});
