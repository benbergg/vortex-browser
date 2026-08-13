import { describe, it, expect } from "vitest";
import { applyFingerprint, type ActionSignals } from "../src/lib/fingerprint-apply.js";
import { normalizeValueFingerprint } from "@vortex-browser/shared";

const valueSignal = (value: string): ActionSignals => ({ kind: "value", value });

describe("applyFingerprint 按 action 派发", () => {
  it("record fill：返回值类指纹", () => {
    const out = applyFingerprint({ mode: "record" }, "fill", "textbox::邮箱::0", valueSignal("a@b.com"));
    expect(out.fingerprint?.action).toBe("fill");
    expect(out.fingerprint?.valueAfter).toBe("a@b.com");
  });

  it("verify fill 值一致 → drift 为 null", () => {
    const expected = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    const out = applyFingerprint(
      { mode: "verify", expect: expected }, "fill", "textbox::邮箱::0", valueSignal("a@b.com"),
    );
    expect(out.drift).toBeNull();
  });

  it("verify fill 值被回滚 → drift 类别 value", () => {
    const expected = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    const out = applyFingerprint(
      { mode: "verify", expect: expected }, "fill", "textbox::邮箱::0", valueSignal(""),
    );
    expect(out.drift?.classes).toEqual(["value"]);
  });

  it("record scroll：返回位置指纹", () => {
    const out = applyFingerprint(
      { mode: "record" }, "scroll", "main::列表::0",
      { kind: "scroll", scrollAfter: { top: 1200, left: 0 } },
    );
    expect(out.fingerprint?.scrollAfter).toEqual({ top: 1200, left: 0 });
  });

  it("信号缺失 → 返回空，绝不臆造", () => {
    expect(applyFingerprint({ mode: "record" }, "fill", "textbox::邮箱::0", undefined)).toEqual({});
  });

  it("targetIdentity 为 null → 显式说明原因而非静默空", () => {
    const out = applyFingerprint({ mode: "record" }, "fill", null, valueSignal("x"));
    expect(out.fingerprintSkipped).toContain("@ref");
  });

  it("hover/drag 等无确定量动作 → 返回空", () => {
    expect(applyFingerprint({ mode: "record" }, "hover", "button::赞::0", undefined)).toEqual({});
  });

  // 上面两条都传了非 null 的 targetIdentity，两种判断顺序下都会通过，锁不住顺序。
  // 只有两者同时缺失时，返回 {} 还是 fingerprintSkipped 才能区分实现的先后。
  it("无信号且无身份 → 返回空而非 skipped：无信号先判", () => {
    expect(applyFingerprint({ mode: "record" }, "hover", null, undefined)).toEqual({});
  });
});
