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
    expect(out).toContain("[blindspot=canvas readback=screenshot]");
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

describe("frame 级虚拟列表盲区（容器未收集时）", () => {
  it("frame.blindspots 进 # blindspots 摘要（按 name+总量）", () => {
    const data = obs([], {
      frames: [{ frameId: 0, parentFrameId: -1, url: "http://x", offset: { x: 0, y: 0 }, elementCount: 80, truncated: false, scanned: true,
        blindspots: [{ kind: "virtual", total: 1003, rendered: 37, name: "grid" }] }],
    });
    const out = renderObserveTree(data as any, null);
    expect(out).toMatch(/# blindspots:.*virtual.*1003\/37/);
  });
  it("A2-fb 低置信虚拟(confidence:low) total 带 ~ 前缀(估算)", () => {
    const data = obs([], {
      frames: [{ frameId: 0, parentFrameId: -1, url: "http://x", offset: { x: 0, y: 0 }, elementCount: 12, truncated: false, scanned: true,
        blindspots: [{ kind: "virtual", total: 1000, rendered: 12, name: "v-vl", confidence: "low" }] }],
    });
    const out = renderObserveTree(data as any, null);
    expect(out).toMatch(/# blindspots:.*v-vl virtual\(~1000\/12\)/);
  });
  it("元素级(canvas) 与 frame级(virtual) 合并到同一 # blindspots 行", () => {
    const data = obs(
      [{ index: 5, tag: "canvas", role: "img", name: "C", frameId: 0, blindspot: { kind: "canvas" } }],
      { frames: [{ frameId: 0, parentFrameId: -1, url: "http://x", offset: { x: 0, y: 0 }, elementCount: 1, truncated: false, scanned: true,
        blindspots: [{ kind: "virtual", total: 1003, rendered: 37, name: "grid" }] }] },
    );
    const out = renderObserveTree(data as any, null);
    expect(out).toMatch(/# blindspots:.*canvas/);
    expect(out).toMatch(/# blindspots:.*virtual.*1003\/37/);
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

describe("canvas readback 指路 (compact)", () => {
  it("canvas chart 渲染 chart + readback=evaluate", () => {
    const out = renderObserveCompact(
      { snapshotId: "s", url: "u", elements: [
        { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0,
          blindspot: { kind: "canvas", readback: "chart", chartLib: "echarts" } },
      ] } as any, null);
    expect(out).toContain("[blindspot=canvas chart=echarts readback=evaluate:getOption]");
    expect(out).toContain("chart(echarts)"); // 顶部 summary 指路
  });

  it("canvas component 渲染 readback=query:component", () => {
    const out = renderObserveCompact(
      { snapshotId: "s", url: "u", elements: [
        { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0,
          blindspot: { kind: "canvas", readback: "component" } },
      ] } as any, null);
    expect(out).toContain("[blindspot=canvas readback=query:component]");
    expect(out).toContain("vortex_query mode=component");
  });

  it("canvas screenshot(纯光栅 + 旧无 readback)渲染 readback=screenshot", () => {
    for (const bs of [{ kind: "canvas", readback: "screenshot" }, { kind: "canvas" }]) {
      const out = renderObserveCompact(
        { snapshotId: "s", url: "u", elements: [
          { index: 0, tag: "canvas", role: "img", name: "C", frameId: 0, blindspot: bs },
        ] } as any, null);
      expect(out).toContain("[blindspot=canvas readback=screenshot]");
    }
  });
});
