// 可验证确定性重放——applyFingerprint / shouldRecover 纯逻辑单测。
// 与 MCP transport 解耦,直接测 record/verify/autoRecover 决策,无需 mock 整条链路。
import { describe, it, expect } from "vitest";
import { applyFingerprint } from "../src/lib/fingerprint-apply.js";

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

  it("targetIdentity 为 null(快照过期/index 未命中)返回空", () => {
    const out = applyFingerprint(
      { mode: "record" },
      "click",
      null,
      { domMutations: 1, networkRequests: 0, urlChanged: false, focusChanged: false, ariaChanged: false, userFeedback: "mutation" },
    );
    expect(out).toEqual({});
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
