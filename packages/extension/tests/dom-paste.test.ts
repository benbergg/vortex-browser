import { describe, it, expect } from "vitest";
import { DomActions } from "@vortex-browser/shared";

describe("dom.paste action 枚举", () => {
  it("DomActions.PASTE 注册为 dom.paste", () => {
    expect(DomActions.PASTE).toBe("dom.paste");
  });
});
