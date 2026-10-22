/**
 * Description: hover 揭示控件 meta 渲染。frame 级 hoverControls → 顶部 # hover-revealed: 行。
 * 这类控件当前不可见、不在元素树里，agent 靠这一行才知道「hover 谁会出什么」。
 */
import { describe, it, expect } from "vitest";
import { renderObserveCompact, renderObserveTree } from "../src/lib/observe-render.js";

const PAIR = {
  triggerSelector: ".flow-start",
  triggerText: "触发",
  controlSelector: ".flow-start .add-icon",
  controlTag: "span",
  controlClasses: "wicon add-icon",
  controlName: "",
  controlCursor: "pointer",
};

function treeData(pairs?: unknown[]) {
  return {
    snapshotId: "snap_hr_1",
    url: "https://example.com/flow",
    elements: [{ index: 0, tag: "span", role: "span", name: "触发", frameId: 0 }],
    frames: [
      {
        frameId: 0,
        parentFrameId: -1,
        url: "https://example.com/flow",
        offset: { x: 0, y: 0 },
        elementCount: 1,
        truncated: false,
        scanned: true,
        ...(pairs ? { hoverControls: pairs } : {}),
      },
    ],
  };
}

describe("observe-render: # hover-revealed meta", () => {
  it("tree 路径：输出 # hover-revealed 行，含触发文本与控件选择器", () => {
    const out = renderObserveTree(treeData([PAIR]) as never, null);
    expect(out).toContain("# hover-revealed:");
    expect(out).toContain('"触发"');
    expect(out).toContain(".flow-start .add-icon");
    // 静态推断不写成已验证事实
    expect(out).toContain("may appear on hovering");
  });

  it("compact 路径：同样输出该行", () => {
    const out = renderObserveCompact(treeData([PAIR]) as never, null);
    expect(out).toContain("# hover-revealed:");
  });

  it("无 hover 控件 → 不输出该行（零漂移）", () => {
    const out = renderObserveTree(treeData() as never, null);
    expect(out).not.toContain("# hover-revealed:");
  });

  it("控件有可及名时优先显示名字", () => {
    const out = renderObserveTree(treeData([{ ...PAIR, controlName: "新增" }]) as never, null);
    expect(out).toContain('"新增"');
  });
});
