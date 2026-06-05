import { describe, it, expect } from "vitest";
import { parseTrustedMode } from "../src/trusted-mode.js";

describe("parseTrustedMode", () => {
  it("带 flag 的 Chrome 行 → true", () => {
    const ps =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --silent-debugger-extension-api\nother proc";
    expect(parseTrustedMode(ps)).toBe(true);
  });

  it("无 flag 的 Chrome → false", () => {
    const ps = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nother";
    expect(parseTrustedMode(ps)).toBe(false);
  });

  it("flag 出现在非 Chrome 行不算(避免误报)", () => {
    const ps = "some-tool --silent-debugger-extension-api\n/X/Google Chrome";
    expect(parseTrustedMode(ps)).toBe(false);
  });

  it("空输出 → false", () => {
    expect(parseTrustedMode("")).toBe(false);
  });
});
