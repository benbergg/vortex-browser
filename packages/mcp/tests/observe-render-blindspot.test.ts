import { describe, it, expect } from "vitest";
import { renderObserveTree, renderObserveCompact } from "../src/lib/observe-render.js";

function obs(elements: any[], extra: any = {}) {
  return { snapshotId: "s1", url: "http://x", elements, ...extra };
}

describe("blindspot inline tag (tree)", () => {
  it("virtual list 渲染 [virtual: total/rendered]", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "div", role: "grid", name: "G", frameId: 0, blindspot: { kind: "virtual", total: 1000, rendered: 32 } },
    ]), null);
    expect(out).toContain("[virtual: 1000/32]");
  });
  it("canvas 渲染 [blindspot=canvas]", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0, blindspot: { kind: "canvas" } },
    ]), null);
    expect(out).toContain("[blindspot=canvas]");
  });
  it("closed shadow 低置信渲染 [blindspot=shadow?]", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "x-widget", role: "generic", name: "W", frameId: 0, blindspot: { kind: "shadow", confidence: "low" } },
    ]), null);
    expect(out).toContain("[blindspot=shadow?]");
  });
  it("无 blindspot 元素不打任何盲区 tag（负例）", () => {
    const out = renderObserveTree(obs([
      { index: 0, tag: "button", role: "button", name: "OK", frameId: 0 },
    ]), null);
    expect(out).not.toContain("blindspot");
    expect(out).not.toContain("[virtual");
  });
});

describe("blindspot 顶部 meta 摘要", () => {
  it("汇总各盲区到 # blindspots 行", () => {
    const out = renderObserveTree(obs([
      { index: 29, tag: "div", role: "grid", name: "G", frameId: 0, blindspot: { kind: "virtual", total: 1000, rendered: 32 } },
      { index: 56, tag: "canvas", role: "img", name: "C", frameId: 0, blindspot: { kind: "canvas" } },
    ]), null);
    expect(out).toMatch(/# blindspots:.*grid.*virtual.*1000\/32/);
    expect(out).toMatch(/# blindspots:.*canvas/);
  });
  it("无盲区不出 # blindspots 行（负例）", () => {
    const out = renderObserveTree(obs([{ index: 0, tag: "button", role: "button", name: "OK", frameId: 0 }]), null);
    expect(out).not.toContain("# blindspots");
  });
  it("compact 模式同样渲染行内 tag", () => {
    const out = renderObserveCompact(obs([
      { index: 0, tag: "div", role: "grid", name: "G", frameId: 0, blindspot: { kind: "virtual", total: 1000, rendered: 32 } },
    ]), null);
    expect(out).toContain("[virtual: 1000/32]");
  });
});

describe("A4 截断量化", () => {
  it("truncated frame 出 # truncated: returned M of ~N", () => {
    const data = obs([], {
      frames: [{ frameId: 0, parentFrameId: -1, url: "http://x", offset: { x: 0, y: 0 }, elementCount: 80, truncated: true, scanned: true, candidateCount: 247 }],
    });
    const out = renderObserveTree(data as any, null);
    expect(out).toMatch(/# truncated: returned 80 of ~247/);
  });
  it("未截断不出 truncated 行（负例）", () => {
    const data = obs([], {
      frames: [{ frameId: 0, parentFrameId: -1, url: "http://x", offset: { x: 0, y: 0 }, elementCount: 12, truncated: false, scanned: true, candidateCount: 12 }],
    });
    expect(renderObserveTree(data as any, null)).not.toContain("# truncated");
  });
});
