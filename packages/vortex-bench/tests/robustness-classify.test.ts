// packages/vortex-bench/tests/robustness-classify.test.ts
import { describe, it, expect } from "vitest";
import { classifyAct, type ActResult } from "../src/runner/robustness-classify.js";

const r = (over: Partial<ActResult>): ActResult => ({ text: "", threw: false, timedOut: false, ...over });

describe("classifyAct", () => {
  it("无错误文本 → ok", () => {
    expect(classifyAct(r({ text: "clicked" }))).toEqual({ kind: "ok", code: null });
  });
  it("Error [OBSCURED]: ... → typed-error + code", () => {
    expect(classifyAct(r({ text: "Error [OBSCURED]: element covered" }))).toEqual({
      kind: "typed-error",
      code: "OBSCURED",
    });
  });
  it("Error [ELEMENT_NOT_FOUND]: ... → typed-error + code", () => {
    expect(classifyAct(r({ text: "Error [ELEMENT_NOT_FOUND]: @x not found\nhint: ..." }))).toEqual({
      kind: "typed-error",
      code: "ELEMENT_NOT_FOUND",
    });
  });
  it("threw(reject)→ crash", () => {
    expect(classifyAct(r({ threw: true, text: "boom" }))).toEqual({ kind: "crash", code: null });
  });
  it("timedOut → timeout(优先于 threw)", () => {
    expect(classifyAct(r({ timedOut: true, threw: true }))).toEqual({ kind: "timeout", code: null });
  });
  it("错误码非行首 → 仍 ok(避免误把正文里的 Error[..] 当 typed-error)", () => {
    expect(classifyAct(r({ text: "result: see Error [X]: above" }))).toEqual({ kind: "ok", code: null });
  });
});
