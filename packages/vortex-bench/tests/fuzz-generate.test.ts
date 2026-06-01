import { describe, it, expect } from "vitest";
import { generate, ALL_PRIMITIVE_KINDS } from "../src/runner/fuzz-generate.js";
import { collectPrimitives, renderHtml } from "../src/runner/fuzz-ast.js";

describe("fuzz-generate", () => {
  it("same seed → structurally identical page (determinism)", () => {
    const a = generate(1234);
    const b = generate(1234);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("different seeds → different pages", () => {
    const a = JSON.stringify(generate(1));
    const b = JSON.stringify(generate(2));
    expect(a).not.toEqual(b);
  });

  it("plants 1..8 primitives, all with unique ids", () => {
    for (let seed = 0; seed < 30; seed++) {
      const prims = collectPrimitives(generate(seed).root);
      expect(prims.length).toBeGreaterThanOrEqual(1);
      expect(prims.length).toBeLessThanOrEqual(8);
      const ids = prims.map((p) => p.id);
      expect(new Set(ids).size).toEqual(ids.length);
    }
  });

  it("generated html is non-empty and renders every primitive", () => {
    const page = generate(99);
    const html = renderHtml(page);
    for (const p of collectPrimitives(page.root)) {
      expect(html).toContain(`data-vtx-oracle="${p.id}"`);
    }
  });

  it("ALL_PRIMITIVE_KINDS covers the 9 starter primitives", () => {
    expect(ALL_PRIMITIVE_KINDS).toHaveLength(9);
  });
});
