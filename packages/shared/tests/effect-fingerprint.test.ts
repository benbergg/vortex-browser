import { describe, it, expect } from "vitest";
import { normalizeClickFingerprint } from "../src/effect-fingerprint.js";

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
