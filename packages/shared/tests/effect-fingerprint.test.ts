import { describe, it, expect } from "vitest";
import {
  normalizeClickFingerprint, normalizeValueFingerprint, normalizeScrollFingerprint,
  compareFingerprint,
} from "../src/effect-fingerprint.js";

describe("normalizeClickFingerprint", () => {
  it("把波动量 domMutations/networkRequests 折成布尔(抗漂移)", () => {
    const fpA = normalizeClickFingerprint("button::Submit::0", {
      domMutations: 14, networkRequests: 2, urlChanged: false,
      focusChanged: false, ariaChanged: false, userFeedback: "mutation",
    });
    const fpB = normalizeClickFingerprint("button::Submit::0", {
      domMutations: 9, networkRequests: 5, urlChanged: false,
      focusChanged: false, ariaChanged: false, userFeedback: "mutation",
    });
    // 数量不同,但归一化后指纹相等
    expect(fpA).toEqual(fpB);
    expect(fpA.causedDomMutation).toBe(true);
    expect(fpA.causedNetwork).toBe(true);
    expect(fpA.action).toBe("click");
    expect(fpA.targetIdentity).toBe("button::Submit::0");
  });

  it("零副作用 → 全 false(silent no-op 签名)", () => {
    const fp = normalizeClickFingerprint("button::Buy::0", {
      domMutations: 0, networkRequests: 0, urlChanged: false,
      focusChanged: false, ariaChanged: false, userFeedback: "none",
    });
    expect(fp.causedDomMutation).toBe(false);
    expect(fp.causedNetwork).toBe(false);
    expect(fp.userFeedback).toBe("none");
  });
});

describe("compareFingerprint", () => {
  const base = {
    action: "click" as const, targetIdentity: "button::Submit::0",
    urlChanged: false, causedDomMutation: true, causedNetwork: true,
    focusChanged: false, ariaChanged: false, userFeedback: "mutation" as const,
  };

  it("效果复现 → matched(null)", () => {
    expect(compareFingerprint(base, { ...base })).toBeNull();
  });

  it("副作用消失 → drift,类别 dom+network", () => {
    const drift = compareFingerprint(base, {
      ...base, causedDomMutation: false, causedNetwork: false, userFeedback: "none",
    });
    expect(drift).not.toBeNull();
    expect(drift!.classes).toContain("dom");
    expect(drift!.classes).toContain("network");
    expect(drift!.classes).toContain("feedback");
  });

  it("目标身份变化 → drift class=target", () => {
    const drift = compareFingerprint(base, { ...base, targetIdentity: "button::Cancel::0" });
    expect(drift!.classes).toEqual(["target"]);
    expect(drift!.details[0]).toMatchObject({
      field: "targetIdentity", expected: "button::Submit::0", actual: "button::Cancel::0",
    });
  });

  it("scrollAfter ±5px 内算匹配", () => {
    const e = { action: "scroll" as const, targetIdentity: "x::y::0", urlChanged: false, scrollAfter: { top: 100, left: 0 } };
    expect(compareFingerprint(e, { ...e, scrollAfter: { top: 103, left: 0 } })).toBeNull();
    expect(compareFingerprint(e, { ...e, scrollAfter: { top: 120, left: 0 } })!.classes).toContain("scroll");
  });

  it("weak fp 只比 target,不比类别", () => {
    const e = { action: "click" as const, targetIdentity: "a::b::0", urlChanged: false, weak: true as const };
    expect(compareFingerprint(e, { ...e, causedDomMutation: true })).toBeNull();
  });
});

describe("normalizeValueFingerprint", () => {
  it("确定量精确保留，不折成布尔", () => {
    const fp = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    expect(fp.action).toBe("fill");
    expect(fp.targetIdentity).toBe("textbox::邮箱::0");
    expect(fp.valueAfter).toBe("a@b.com");
    // 值类动作没有副作用类别签名，必须不带，否则 compare 会拿 undefined 去比
    expect(fp.causedDomMutation).toBeUndefined();
    expect(fp.causedNetwork).toBeUndefined();
  });

  it("urlChanged 恒 false：填值不导航", () => {
    expect(normalizeValueFingerprint("select", "combobox::城市::0", "北京").urlChanged).toBe(false);
  });

  it("值不同 → drift 类别 value", () => {
    const a = normalizeValueFingerprint("fill", "textbox::邮箱::0", "a@b.com");
    const b = normalizeValueFingerprint("fill", "textbox::邮箱::0", "x@y.com");
    expect(compareFingerprint(a, b)?.classes).toEqual(["value"]);
  });

  it("值相同 → matched", () => {
    const a = normalizeValueFingerprint("type", "textbox::正文::0", "hello");
    const b = normalizeValueFingerprint("type", "textbox::正文::0", "hello");
    expect(compareFingerprint(a, b)).toBeNull();
  });
});

describe("normalizeScrollFingerprint", () => {
  it("位置差在 ±5px 容差内视为 matched", () => {
    const a = normalizeScrollFingerprint("main::列表::0", { top: 1200, left: 0 });
    const b = normalizeScrollFingerprint("main::列表::0", { top: 1204, left: 0 });
    expect(compareFingerprint(a, b)).toBeNull();
  });

  it("超出容差 → drift 类别 scroll", () => {
    const a = normalizeScrollFingerprint("main::列表::0", { top: 1200, left: 0 });
    const b = normalizeScrollFingerprint("main::列表::0", { top: 1400, left: 0 });
    expect(compareFingerprint(a, b)?.classes).toEqual(["scroll"]);
  });
});
