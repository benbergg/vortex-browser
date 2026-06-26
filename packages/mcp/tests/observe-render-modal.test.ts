/**
 * Description: 模态作用域 meta 渲染(N002 T2-2)。frame 级 modal 信号 → 顶部 # modal: 行,
 *   对齐 # blindspots: 风格。
 */
import { describe, it, expect } from "vitest";
import { renderObserveCompact, renderObserveTree } from "../src/lib/observe-render.js";

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: "snap_test_1",
    url: "https://example.com/dialog",
    title: "Dialog Demo",
    viewport: { width: 1440, height: 788, scrollY: 0, scrollHeight: 2000 },
    elements: [
      { ref: "@a:e0", role: "button", name: "Confirm", state: {} },
      { ref: "@a:e1", role: "button", name: "Cancel", state: {} },
    ],
    frames: [
      { frameId: 0, parentFrameId: -1, url: "https://example.com/dialog", elementCount: 2, truncated: false, scanned: true, modal: { name: "Tips", role: "dialog", suppressed: 56 } },
    ],
    ...overrides,
  };
}

describe("observe-render: # modal meta", () => {
  it("有 active modal → 顶部输出 # modal: 行含 name + suppressed 数", () => {
    const out = renderObserveCompact(baseData() as never, null);
    expect(out).toMatch(/# modal: dialog "Tips" \(suppressed 56 background elements\)/);
  });
  it("无 modal → 不输出 # modal: 行(零漂移)", () => {
    const data = baseData();
    (data.frames[0] as Record<string, unknown>).modal = undefined;
    const out = renderObserveCompact(data as never, null);
    expect(out).not.toContain("# modal:");
  });
});

describe("observe-render: [behind-modal] tag (filter=all)", () => {
  it("背景元素带 behindModal=true → 行尾渲染 [behind-modal]", () => {
    const data = {
      snapshotId: "snap_test_2",
      url: "https://example.com/dialog",
      title: "Dialog Demo",
      viewport: { width: 1440, height: 788, scrollY: 0, scrollHeight: 2000 },
      elements: [
        { ref: "@a:e0", role: "button", name: "Confirm", state: {} },
        { ref: "@a:e1", role: "link", name: "nav", state: {}, behindModal: true },
      ],
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://example.com/dialog", elementCount: 2, truncated: false, scanned: true }],
    };
    const out = renderObserveCompact(data as never, null);
    const navLine = out.split("\n").find((l) => l.includes('"nav"'))!;
    expect(navLine).toContain("[behind-modal]");
    const okLine = out.split("\n").find((l) => l.includes('"Confirm"'))!;
    expect(okLine).not.toContain("[behind-modal]");
  });
});

describe("observe-render: # modal meta (tree —— 真实 observe 工具渲染路径)", () => {
  // vortex_observe 走 renderObserveTree(server.ts),非 renderObserveCompact。
  // # modal: 必须加在 tree 路径,否则数据层裁剪生效但 meta 不渲染(2026-06-26 实机 spike 实证)。
  function treeData(modal?: { name: string; role: string; suppressed: number }) {
    return {
      snapshotId: "snap_tree_1",
      url: "http://x/dialog",
      elements: [{ index: 0, tag: "button", role: "button", name: "Confirm", frameId: 0 }],
      frames: [{ frameId: 0, parentFrameId: -1, url: "http://x/dialog", offset: { x: 0, y: 0 }, elementCount: 1, truncated: false, scanned: true, ...(modal ? { modal } : {}) }],
    };
  }
  it("有 active modal → renderObserveTree 顶部输出 # modal: 行", () => {
    const out = renderObserveTree(treeData({ name: "Tips", role: "dialog", suppressed: 56 }) as never, null);
    expect(out).toMatch(/# modal: dialog "Tips" \(suppressed 56 background elements\)/);
  });
  it("无 modal → renderObserveTree 不出 # modal: 行(零漂移)", () => {
    const out = renderObserveTree(treeData() as never, null);
    expect(out).not.toContain("# modal:");
  });
});