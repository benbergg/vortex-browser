import { describe, it, expect } from "vitest";
import { VtxError, VtxErrorCode } from "../src/errors.js";
import { DEFAULT_ERROR_META, vtxError } from "../src/errors.hints.js";

describe("VtxError", () => {
  it("basic construction serializes to minimal {code, message}", () => {
    const err = new VtxError(VtxErrorCode.ELEMENT_NOT_FOUND, "not found");
    expect(err.toJSON()).toEqual({
      code: "ELEMENT_NOT_FOUND",
      message: "not found",
    });
  });

  it("no extra keeps payload backwards-compatible (no hint/recoverable/context)", () => {
    const err = new VtxError(VtxErrorCode.TIMEOUT, "timeout");
    const json = err.toJSON();
    expect(json).not.toHaveProperty("hint");
    expect(json).not.toHaveProperty("recoverable");
    expect(json).not.toHaveProperty("context");
  });

  it("with extra serializes hint/recoverable/context", () => {
    const err = new VtxError(VtxErrorCode.ELEMENT_OCCLUDED, "occluded", {
      hint: "dismiss overlay",
      recoverable: true,
      context: { selector: "button.submit" },
    });
    expect(err.toJSON()).toEqual({
      code: "ELEMENT_OCCLUDED",
      message: "occluded",
      hint: "dismiss overlay",
      recoverable: true,
      context: { selector: "button.submit" },
    });
  });

  it("toString includes code for debugging", () => {
    const err = new VtxError(VtxErrorCode.TAB_NOT_FOUND, "nope");
    expect(err.toString()).toBe("VtxError[TAB_NOT_FOUND]: nope");
  });

  it("is instanceof Error (catchable by generic error handlers)", () => {
    const err = new VtxError(VtxErrorCode.INVALID_PARAMS, "bad");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("VtxError");
  });

  it("context.extras tolerates arbitrary structured data", () => {
    const err = new VtxError(VtxErrorCode.ELEMENT_OCCLUDED, "covered", {
      context: { selector: "#a", extras: { blocker: "div.modal" } },
    });
    expect(err.toJSON().context).toEqual({
      selector: "#a",
      extras: { blocker: "div.modal" },
    });
  });
});

describe("VtxErrorCode enum", () => {
  it("includes all 47 error codes (24 base + 2 组件 + 9 L2 + 9 L3 + 2 L4 + 1 act-verify)", () => {
    expect(Object.keys(VtxErrorCode)).toHaveLength(47);
  });

  it("each constant equals its own string value (self-describing)", () => {
    for (const [k, v] of Object.entries(VtxErrorCode)) {
      expect(v).toBe(k);
    }
  });

  it("exposes newly added codes from W1", () => {
    expect(VtxErrorCode.ELEMENT_OCCLUDED).toBe("ELEMENT_OCCLUDED");
    expect(VtxErrorCode.STALE_SNAPSHOT).toBe("STALE_SNAPSHOT");
    expect(VtxErrorCode.INVALID_INDEX).toBe("INVALID_INDEX");
    expect(VtxErrorCode.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
  });

  it("exposes UNSUPPORTED_TARGET (@since 0.4.0)", () => {
    expect(VtxErrorCode.UNSUPPORTED_TARGET).toBe("UNSUPPORTED_TARGET");
  });

  it("exposes COMMIT_FAILED (@since 0.4.0)", () => {
    expect(VtxErrorCode.COMMIT_FAILED).toBe("COMMIT_FAILED");
  });
});

describe("DEFAULT_ERROR_META coverage", () => {
  it("covers every VtxErrorCode", () => {
    for (const code of Object.values(VtxErrorCode)) {
      const meta = DEFAULT_ERROR_META[code];
      expect(meta).toBeDefined();
      expect(meta.hint).toBeTruthy();
      expect(typeof meta.recoverable).toBe("boolean");
    }
  });

  it("hints are LLM-oriented English sentences (not empty, contain action verbs)", () => {
    for (const code of Object.values(VtxErrorCode)) {
      const hint = DEFAULT_ERROR_META[code].hint;
      expect(hint.length).toBeGreaterThan(10);
    }
  });

  it("TAB_CLOSED and JS_EXECUTION_ERROR are marked non-recoverable per design", () => {
    expect(DEFAULT_ERROR_META.TAB_CLOSED.recoverable).toBe(false);
    expect(DEFAULT_ERROR_META.JS_EXECUTION_ERROR.recoverable).toBe(false);
  });

  it("ELEMENT_OCCLUDED and STALE_SNAPSHOT are recoverable", () => {
    expect(DEFAULT_ERROR_META.ELEMENT_OCCLUDED.recoverable).toBe(true);
    expect(DEFAULT_ERROR_META.STALE_SNAPSHOT.recoverable).toBe(true);
  });

  // ============================================================
  // P1-2 残留修复(vortex-bench 2026-06-07 淘宝评测 V3 §3.3):
  // NOT_STABLE 在 sticky/fixed 容器 + CSS transition 场景频繁误报(0.5px 容差
  // 仍不够,如天猫"加入购物车"按钮 `transition: bottom 0.15s`)。
  // 不修代码(项目 c8928c0 已判定时序不可控),改 hint 显式建议 `force=true` 兜底。
  // 验收:NOT_STABLE hint 让 LLM 一次看明白如何降级。
  // ============================================================

  it("NOT_STABLE hint 提及 sticky/fixed/transition 容器场景 (vortex-bench 2026-06-07 P1-2 残留)", () => {
    const hint = DEFAULT_ERROR_META.NOT_STABLE.hint;
    // 命中任一关键词即视为覆盖 sticky/fixed 容器场景
    const coversContainer = /sticky|fixed|position:\s*(sticky|fixed)|ancestor/i.test(hint);
    const coversTransition = /transition|animation|CSS/i.test(hint);
    expect(coversContainer).toBe(true);
    expect(coversTransition).toBe(true);
  });

  it("NOT_STABLE hint 显式建议 force=true 兜底 (优雅降级,避免 LLM 重试循环)", () => {
    const hint = DEFAULT_ERROR_META.NOT_STABLE.hint;
    expect(hint).toMatch(/force\s*[:=]\s*true|force=true/);
  });
});

describe("vtxError factory", () => {
  it("injects default hint and recoverable from DEFAULT_ERROR_META", () => {
    const err = vtxError(VtxErrorCode.ELEMENT_OCCLUDED, "hidden by modal");
    const json = err.toJSON();
    expect(json.hint).toBe(DEFAULT_ERROR_META.ELEMENT_OCCLUDED.hint);
    expect(json.recoverable).toBe(true);
  });

  it("attaches context when provided", () => {
    const err = vtxError(VtxErrorCode.STALE_SNAPSHOT, "expired", {
      snapshotId: "snap_abc",
    });
    expect(err.toJSON().context).toEqual({ snapshotId: "snap_abc" });
  });

  it("omits context when not provided", () => {
    const err = vtxError(VtxErrorCode.TIMEOUT, "slow");
    expect(err.toJSON()).not.toHaveProperty("context");
  });

  it("override.hint overrides default", () => {
    const err = vtxError(
      VtxErrorCode.INVALID_PARAMS,
      "gif already recording",
      undefined,
      { hint: "Stop the current recording first." },
    );
    expect(err.toJSON().hint).toBe("Stop the current recording first.");
  });

  it("override.recoverable overrides default", () => {
    const err = vtxError(
      VtxErrorCode.TIMEOUT,
      "gave up",
      undefined,
      { recoverable: false },
    );
    expect(err.toJSON().recoverable).toBe(false);
  });

  it("returns a real VtxError (throwable)", () => {
    const err = vtxError(VtxErrorCode.INVALID_PARAMS, "x");
    expect(err).toBeInstanceOf(VtxError);
    expect(() => {
      throw err;
    }).toThrow(VtxError);
  });
});
