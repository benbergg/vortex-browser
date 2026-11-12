import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Browser coverage verifies label priority and exclusion of nested controls.
const source = readFileSync(new URL("../src/handlers/observe.ts", import.meta.url), "utf8");

describe("wrapping label scan integration", () => {
  it("uses visible label text excluding controls before the placeholder fallback", () => {
    const label = source.indexOf("const txt = normName(visibleTextContent(wrapLabel, true))");
    const placeholder = source.indexOf('el.getAttribute("placeholder") || el.getAttribute("title") || ""', label);
    expect(label).toBeGreaterThan(0);
    expect(placeholder).toBeGreaterThan(label);
  });
});
