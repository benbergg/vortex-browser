import { describe, it, expect } from "vitest";
import { shrink } from "../src/runner/fuzz-shrink.js";
import { collectPrimitives } from "../src/runner/fuzz-ast.js";
import { generate } from "../src/runner/fuzz-generate.js";
import type { FuzzPage } from "../src/fuzz-types.js";

describe("fuzz-shrink", () => {
  it("reduces to a page still containing the culprit primitive", async () => {
    const page = generate(12345);
    const prims = collectPrimitives(page.root);
    const culprit = prims[prims.length - 1].id;
    const stillFails = async (p: FuzzPage) =>
      collectPrimitives(p.root).some((x) => x.id === culprit);
    const min = await shrink(page, stillFails);
    const minPrims = collectPrimitives(min.root);
    expect(minPrims.some((x) => x.id === culprit)).toBe(true);
    expect(minPrims.length).toBeLessThanOrEqual(prims.length);
    expect(minPrims.length).toBeGreaterThanOrEqual(1);
  });

  it("never returns a page that fails the predicate", async () => {
    const page = generate(777);
    const prims = collectPrimitives(page.root);
    const keep = prims[0].id;
    const stillFails = async (p: FuzzPage) =>
      collectPrimitives(p.root).some((x) => x.id === keep);
    const min = await shrink(page, stillFails);
    expect(await stillFails(min)).toBe(true);
  });

  it("monotonic: result no larger than input", async () => {
    const page = generate(555);
    const stillFails = async () => true;
    const min = await shrink(page, stillFails);
    const minPrims = collectPrimitives(min.root);
    expect(minPrims.length).toBe(0);
  });
});
