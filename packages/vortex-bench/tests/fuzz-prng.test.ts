import { describe, it, expect } from "vitest";
import { makePrng } from "../src/runner/fuzz-prng.js";

describe("fuzz-prng", () => {
  it("same seed → identical sequence (determinism)", () => {
    const a = makePrng(42);
    const b = makePrng(42);
    const seqA = [a.int(100), a.int(100), a.int(100)];
    const seqB = [b.int(100), b.int(100), b.int(100)];
    expect(seqA).toEqual(seqB);
  });

  it("different seeds → different sequence", () => {
    const a = makePrng(1);
    const b = makePrng(2);
    expect(a.int(1_000_000)).not.toEqual(b.int(1_000_000));
  });

  it("int(n) stays in [0,n)", () => {
    const r = makePrng(7);
    for (let i = 0; i < 200; i++) {
      const v = r.int(5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
  });

  it("pick returns an element; shuffle is a permutation", () => {
    const r = makePrng(9);
    const arr = [1, 2, 3, 4, 5];
    expect(arr).toContain(r.pick(arr));
    const sh = r.shuffle(arr);
    expect([...sh].sort()).toEqual([...arr].sort());
    expect(sh).toHaveLength(arr.length);
  });
});
