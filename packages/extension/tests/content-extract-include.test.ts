import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for vortex_extract include:["value","attrs"] support
 * (P0-1, 2026-05-21). Before this fix, the GET_TEXT handler silently
 * dropped the include/maxDepth params and only returned el.innerText —
 * making the public schema's `include: ["text","value","attrs"]` a
 * dead promise. Users were forced to screenshot to read form values.
 *
 * Source-level contract: GET_TEXT must
 *   1. read args.include as a string[] and detect "value" / "attrs"
 *   2. when wanted, walk the subtree under the resolved root and emit
 *      a controls[] array describing input/textarea/select/contentEditable
 *   3. honour args.maxDepth to bound the walker
 *   4. return a structured { text, controls } envelope when include
 *      requested form data (string return is preserved for the
 *      include=["text"] default to keep older callers working)
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "content.ts"),
  "utf8",
);

describe("content.getText include:value/attrs (P0-1, v0.8.1)", () => {
  it("reads args.include as string[] and detects 'value' / 'attrs'", () => {
    expect(SRC).toMatch(/includeRaw\s*=\s*Array\.isArray\(args\.include\)/);
    expect(SRC).toMatch(/wantValue\s*=.*includes\("value"\)/);
    expect(SRC).toMatch(/wantAttrs\s*=.*includes\("attrs"\)/);
  });

  it("reads args.maxDepth with a sane default (was completely ignored)", () => {
    expect(SRC).toMatch(/maxDepth\s*=.*args\.maxDepth/);
  });

  it("page-side walker reads input.value / textarea.value / select.value", () => {
    expect(SRC).toMatch(/HTMLInputElement/);
    expect(SRC).toMatch(/HTMLTextAreaElement/);
    expect(SRC).toMatch(/HTMLSelectElement/);
  });

  it("checkbox / radio return checked state", () => {
    expect(SRC).toMatch(/inp\.type\s*===\s*"checkbox"/);
    expect(SRC).toMatch(/inp\.checked/);
  });

  it("select multiple returns selectedOptions array", () => {
    expect(SRC).toMatch(/selectedOptions/);
  });

  it("contentEditable branches and emits value/textContent", () => {
    expect(SRC).toMatch(/isContentEditable/);
  });

  it("input[type=hidden] is not silently filtered (whitelist exception)", () => {
    expect(SRC).toMatch(/"hidden"/);
  });

  it("structured response shape { text, controls } when value/attrs requested", () => {
    expect(SRC).toMatch(/return\s*\{\s*result:\s*\{\s*text,\s*controls\s*\}/);
  });

  it("returns plain string when only 'text' is requested (back-compat)", () => {
    expect(SRC).toMatch(/!opts\.wantValue\s*&&\s*!opts\.wantAttrs[\s\S]*return\s*\{\s*result:\s*text\s*\}/);
  });

  it("selector miss still throws ELEMENT_NOT_FOUND (P0-2 regression lock)", () => {
    expect(SRC).toMatch(/Element not found:/);
    expect(SRC).toMatch(/ELEMENT_NOT_FOUND/);
  });
});
