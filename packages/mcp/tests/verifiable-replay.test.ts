// 可验证确定性重放——applyFingerprint / shouldRecover 纯逻辑单测。
// 与 MCP transport 解耦,直接测 record/verify/autoRecover 决策,无需 mock 整条链路。
import { describe, it, expect } from "vitest";
import { applyFingerprint, shouldRecover } from "../src/lib/fingerprint-apply.js";

describe("applyFingerprint selector path (Finding 3 — 诚实 fingerprintSkipped)", () => {
  const effect = {
    domMutations: 1, networkRequests: 0, urlChanged: false,
    focusChanged: false, ariaChanged: false, userFeedback: "mutation" as const,
  };

  it("click + effect + targetIdentity=null → fingerprintSkipped 非空字符串(非 {})", () => {
    const out = applyFingerprint({ mode: "record" }, "click", null, effect);
    expect(out).toHaveProperty("fingerprintSkipped");
    expect(typeof out.fingerprintSkipped).toBe("string");
    expect((out.fingerprintSkipped as string).length).toBeGreaterThan(0);
    // 不应有 fingerprint 或 drift
    expect(out.fingerprint).toBeUndefined();
    expect(out.drift).toBeUndefined();
  });

  it("verify 模式 + targetIdentity=null 同样返回 fingerprintSkipped", () => {
    const expectFp = {
      action: "click" as const, targetIdentity: "button::Submit::0", urlChanged: false,
      causedDomMutation: true, causedNetwork: false, focusChanged: false,
      ariaChanged: false, userFeedback: "mutation" as const,
    };
    const out = applyFingerprint({ mode: "verify", expect: expectFp }, "click", null, effect);
    expect(out).toHaveProperty("fingerprintSkipped");
    expect(out.fingerprint).toBeUndefined();
    expect(out.drift).toBeUndefined();
  });

  it("record + @ref 身份(targetIdentity 非 null)→ 正常返回 fingerprint,不受影响", () => {
    const out = applyFingerprint({ mode: "record" }, "click", "button::Submit::0", effect);
    expect(out.fingerprint).toBeDefined();
    expect(out.fingerprintSkipped).toBeUndefined();
  });
});

describe("applyFingerprint record", () => {
  it("record 模式把 click effect 归一化进响应", () => {
    const out = applyFingerprint(
      { mode: "record" },
      "click",
      "button::Submit::0",
      { domMutations: 3, networkRequests: 1, urlChanged: false, focusChanged: false, ariaChanged: false, userFeedback: "mutation" },
    );
    expect(out.fingerprint).toMatchObject({ action: "click", targetIdentity: "button::Submit::0", causedDomMutation: true });
    expect(out.drift).toBeUndefined();
  });

  it("非 click action 返回空(Phase 1 仅 click 有 effect)", () => {
    const out = applyFingerprint(
      { mode: "record" },
      "fill",
      "textbox::Email::0",
      { domMutations: 3, networkRequests: 0, urlChanged: false, focusChanged: false, ariaChanged: false, userFeedback: "none" },
    );
    expect(out).toEqual({});
  });

  it("effect 缺失返回空(observeEffect 未生效 / 无副作用信号)", () => {
    const out = applyFingerprint({ mode: "record" }, "click", "button::Submit::0", undefined);
    expect(out).toEqual({});
  });

  it("targetIdentity 为 null(CSS selector / 快照过期 / index 未命中)→ fingerprintSkipped(诚实信号,非空 {})", () => {
    const out = applyFingerprint(
      { mode: "record" },
      "click",
      null,
      { domMutations: 1, networkRequests: 0, urlChanged: false, focusChanged: false, ariaChanged: false, userFeedback: "mutation" },
    );
    // 改动:不再静默返回 {},而是携带 fingerprintSkipped 说明无法建立指纹的原因。
    expect(out.fingerprintSkipped).toBeTruthy();
    expect(out.fingerprint).toBeUndefined();
  });
});

describe("applyFingerprint verify", () => {
  const expectFp = {
    action: "click" as const, targetIdentity: "button::Submit::0", urlChanged: false,
    causedDomMutation: true, causedNetwork: true, focusChanged: false, ariaChanged: false, userFeedback: "mutation" as const,
  };
  it("效果复现 → drift null(matched)", () => {
    const out = applyFingerprint({ mode: "verify", expect: expectFp }, "click", "button::Submit::0",
      { domMutations: 5, networkRequests: 2, urlChanged: false, focusChanged: false, ariaChanged: false, userFeedback: "mutation" });
    expect(out.drift).toBeNull();
    // verify 也回传本次实测指纹(诚实表征:即便 matched 也让调用方看到实测值)。
    expect(out.fingerprint).toMatchObject({ action: "click", targetIdentity: "button::Submit::0" });
  });
  it("副作用消失 → drift 含 dom/network/feedback", () => {
    const out = applyFingerprint({ mode: "verify", expect: expectFp }, "click", "button::Submit::0",
      { domMutations: 0, networkRequests: 0, urlChanged: false, focusChanged: false, ariaChanged: false, userFeedback: "none" });
    expect(out.drift!.classes).toEqual(expect.arrayContaining(["dom", "network", "feedback"]));
  });
});

describe("shouldRecover", () => {
  it("autoRecover 且 drift 非空 → true", () => {
    expect(shouldRecover({ mode: "verify", expect: {} as any, autoRecover: true }, { classes: ["dom"], details: [] })).toBe(true);
  });
  it("drift null → false", () => {
    expect(shouldRecover({ mode: "verify", expect: {} as any, autoRecover: true }, null)).toBe(false);
  });
  it("未开 autoRecover → false(诚实优先,交回调用方)", () => {
    expect(shouldRecover({ mode: "verify", expect: {} as any }, { classes: ["dom"], details: [] })).toBe(false);
  });
  it("record 模式 → false(record 无 drift 概念)", () => {
    expect(shouldRecover({ mode: "record" }, null)).toBe(false);
  });
});
