// packages/vortex-bench/src/runner/fuzz-prng.ts
// mulberry32 seeded PRNG —— 决定论、零依赖。fuzz 全程用它,保证同 seed 复现同页。

export interface Prng {
  /** [0,1) 浮点 */
  next(): number;
  /** [0,n) 整数 */
  int(n: number): number;
  /** 概率 p 返回 true(默认 0.5) */
  bool(p?: number): boolean;
  /** 数组随机一项 */
  pick<T>(arr: readonly T[]): T;
  /** 返回打乱的新数组(不改原数组) */
  shuffle<T>(arr: readonly T[]): T[];
}

export function makePrng(seed: number): Prng {
  // mulberry32 state:32 位无符号
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const bool = (p = 0.5): boolean => next() < p;
  const pick = <T,>(arr: readonly T[]): T => arr[int(arr.length)];
  const shuffle = <T,>(arr: readonly T[]): T[] => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { next, int, bool, pick, shuffle };
}
