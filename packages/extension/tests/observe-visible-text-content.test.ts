import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The actual scan behavior is exercised in observe-vxe.browser.test.ts.
const source = readFileSync(new URL("../src/handlers/observe.ts", import.meta.url), "utf8");

describe("visible text scan integration", () => {
  it("uses the visible text helper for fallback names and wrapping labels", () => {
    expect(source).toMatch(/const text = normName\(visibleTextContent\(el\)\)/);
    expect(source).toMatch(/const labelText = normName\(visibleTextContent\(el\)\)/);
  });
});
