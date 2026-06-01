import { describe, it, expect } from "vitest";
import { structuralHash } from "../src/runner/fuzz-promote.js";
import { generate } from "../src/runner/fuzz-generate.js";

describe("fuzz-promote structuralHash", () => {
  it("same structure → same hash (ignores seed field)", () => {
    const a = generate(111);
    const b = { ...a, seed: 999 };
    expect(structuralHash(a)).toEqual(structuralHash(b));
  });
  it("different structure → different hash", () => {
    expect(structuralHash(generate(1))).not.toEqual(structuralHash(generate(2)));
  });
  it("hash is a short hex string", () => {
    expect(structuralHash(generate(5))).toMatch(/^[0-9a-f]{8,}$/);
  });
});
