/**
 * Author: qingwa
 * Description: INVALID_SELECTOR 也必须能走 descriptor 自愈通道。
 *
 * 回归背景：INVALID_SELECTOR（不可重试）落地后，非法 CSS 立即抛错、不再自旋到
 * TIMEOUT，于是 isStaleNotAttached（要求 code=TIMEOUT/NOT_ATTACHED 且
 * lastReason=NOT_ATTACHED）恒为 false → healAwareGate 的自愈分支被绕过。
 *
 * 这会真实退化一条既有能力：observe 的 buildSelector 用 aria-label / data-testid
 * 拼锚点选择器时只转义了 \ 和 "，**不处理裸换行**（observe.ts:1786/1805）。HTML 里
 * 把长 aria-label 折行很常见，生成的 `button[aria-label="line1\nline2"]` 是非法 CSS。
 *   - 改动前：非法 → NOT_ATTACHED 自旋 → TIMEOUT(lastReason=NOT_ATTACHED)
 *             → tryHealSelector 按 descriptor 重定位，大概率救回来。
 *   - 改动后：立即 INVALID_SELECTOR → 自愈通道断掉 → 硬失败，且文案让调用方
 *             "改用 @ref"——而它传的**就是** @ref，又一次方向相反的诊断。
 *
 * 故：选择器不可用（零命中 或 语法非法）且握有 descriptor 时，都应尝试自愈。
 */

import { describe, it, expect } from "vitest";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";
import { isHealableSelectorFailure, isStaleNotAttached } from "../src/action/heal.js";

describe("isHealableSelectorFailure — 自愈准入判据", () => {
  it("INVALID_SELECTOR → true（observe 生成的锚点可能语法非法，descriptor 能救）", () => {
    const err = vtxError(
      VtxErrorCode.INVALID_SELECTOR,
      'INVALID_SELECTOR: "button[aria-label="a\nb"]" is not valid CSS',
      { selector: 'button[aria-label="a\nb"]' },
    );
    expect(isHealableSelectorFailure(err)).toBe(true);
  });

  it("TIMEOUT + lastReason=NOT_ATTACHED → true（保留原有通道）", () => {
    const err = vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", {
      selector: "#x",
      extras: { lastReason: "NOT_ATTACHED" },
    });
    expect(isHealableSelectorFailure(err)).toBe(true);
  });

  it("OBSCURED 之类的真实可操作性失败 → false（不该拿 descriptor 乱换目标）", () => {
    const err = vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", {
      selector: "#x",
      extras: { lastReason: "OBSCURED" },
    });
    expect(isHealableSelectorFailure(err)).toBe(false);
  });

  it("NOT_EDITABLE → false", () => {
    const err = vtxError(VtxErrorCode.NOT_EDITABLE, "not editable", { selector: "#x" });
    expect(isHealableSelectorFailure(err)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isHealableSelectorFailure(undefined)).toBe(false);
  });

  it("isStaleNotAttached 语义保持不变（不因新增码而放宽）", () => {
    const invalid = vtxError(VtxErrorCode.INVALID_SELECTOR, "bad css", { selector: "#x" });
    expect(isStaleNotAttached(invalid)).toBe(false);
  });
});
