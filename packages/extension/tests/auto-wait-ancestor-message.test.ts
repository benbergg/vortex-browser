/**
 * Author: qingwa
 * Description: 祖先命中的话术必须与「被浮层盖住」区分——修法完全不同:
 *   浮层要关掉,祖先裁剪要滚动容器/换目标,让调用方去找浮层是死路。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxError, VtxErrorCode } from "@vortex-browser/shared";

const checkActionability = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...args: unknown[]) => checkActionability(...args),
}));

const { buildActionabilityTimeoutDiagnosis, waitActionable } = await import("../src/action/auto-wait.js");

async function thrownFrom(extras: Record<string, unknown>): Promise<VtxError> {
  checkActionability.mockResolvedValue({ ok: false, reason: "OBSCURED", extras });
  try {
    await waitActionable(42, undefined, "#t", { timeout: 120 });
  } catch (e) {
    return e as VtxError;
  }
  throw new Error("waitActionable 未抛错");
}

describe("祖先命中话术", () => {
  it("hitKind=ancestor → 点名祖先并给裁剪/pointer-events 处方", () => {
    const { message: msg } = buildActionabilityTimeoutDiagnosis({
      timeout: 2000, lastReason: "OBSCURED",
      lastExtras: { blocker: "div#track-wrap", hitKind: "ancestor", modalBlocked: false },
    });
    expect(msg).toContain("div#track-wrap");
    expect(msg).toContain("ancestor");
    expect(msg).not.toContain("dismiss");
  });

  it("hitKind=overlay → 保持既有「被谁盖住」话术（回归保护）", () => {
    const { message: msg } = buildActionabilityTimeoutDiagnosis({
      timeout: 2000, lastReason: "OBSCURED",
      lastExtras: { blocker: "div#mask", hitKind: "overlay", modalBlocked: false },
    });
    expect(msg).toContain("covered by <div#mask>");
  });
});

describe("祖先命中投递给调用方的 payload", () => {
  beforeEach(() => checkActionability.mockReset());

  it("hitKind=ancestor → payload.hint 不再指引去关不存在的浮层", async () => {
    const payload = (await thrownFrom({ blocker: "div#track-wrap", hitKind: "ancestor" })).toJSON();
    expect(payload.code).toBe(VtxErrorCode.OBSCURED);
    expect(payload.hint).toBeDefined();
    expect(payload.hint).not.toMatch(/dismiss|close control|scroll away that element/i);
    expect(payload.hint).toMatch(/ancestor/i);
  });

  it("中心点落空 → payload.hint 也不指向浮层（三条路径同一份）", async () => {
    const payload = (await thrownFrom({ blocker: "elementFromPoint=null" })).toJSON();
    expect(payload.message).toMatch(/no element at all/i);
    expect(payload.hint).toMatch(/viewport|scroll/i);
    expect(payload.hint).not.toMatch(/dismiss/i);
  });

  it("hitKind=overlay → payload.hint 保持既有关浮层话术（回归保护）", async () => {
    const payload = (await thrownFrom({ blocker: "div#mask", hitKind: "overlay" })).toJSON();
    expect(payload.hint).toMatch(/dismiss/i);
  });
});
