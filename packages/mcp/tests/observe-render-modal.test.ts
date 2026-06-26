/**
 * Description: 模态作用域 meta 渲染(N002 T2-2)。frame 级 modal 信号 → 顶部 # modal: 行,
 *   对齐 # blindspots: 风格。
 */
import { describe, it, expect } from "vitest";
import { renderObserveCompact } from "../src/lib/observe-render.js";

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