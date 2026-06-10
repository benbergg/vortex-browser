import { describe, it, expect } from "vitest";

// 复刻 handler 重映射：每 frame 连续编号，globalParent = frameBase + localParent。
function remap(frames: { localParents: (number | undefined)[] }[]): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let cursor = 0;
  for (const f of frames) {
    const base = cursor;
    for (const lp of f.localParents) {
      out.push(lp !== undefined ? base + lp : undefined);
      cursor++;
    }
  }
  return out;
}

describe("parentIndex frame-local → global 重映射", () => {
  it("single frame: 偏移 0，原样", () => {
    expect(remap([{ localParents: [undefined, 0, 1] }])).toEqual([undefined, 0, 1]);
  });
  it("two frames: 第二 frame 加 frameBase", () => {
    expect(remap([
      { localParents: [undefined, 0] },
      { localParents: [undefined, 0] },
    ])).toEqual([undefined, 0, undefined, 2]);
  });
});
