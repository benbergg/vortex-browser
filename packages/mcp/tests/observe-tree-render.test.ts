import { describe, it, expect } from "vitest";
import { renderObserveTree } from "../src/lib/observe-render.js";
import type { CompactElement } from "../src/lib/observe-render.js";

const mk = (o: Partial<CompactElement> & { index: number; role: string }): CompactElement => ({
  tag: "div", name: "", frameId: 0, ...o,
} as CompactElement);

function body(out: string): string {
  // 跳过 header（SnapshotId/URL/Title/Viewport + 空行），只取树体
  return out.split("\n").slice(out.split("\n").indexOf("") + 1).join("\n");
}

describe("renderObserveTree", () => {
  const base = (els: CompactElement[]) => ({
    snapshotId: "snap_x", url: "http://t", elements: els,
  });

  it("nests children under parent with 2-space indent and trailing colon", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "list", name: "小程序" }),
      mk({ index: 1, role: "listitem", name: "VOC工作台", parentIndex: 0 }),
      mk({ index: 2, role: "button", name: "+ 新增", parentIndex: 1, reactClickable: true }),
    ]), null);
    expect(body(out)).toBe(
      `- list "小程序" [ref=@e0]:\n` +
      `  - listitem "VOC工作台" [ref=@e1]:\n` +
      `    - button "+ 新增" [ref=@e2] [cursor=pointer]`
    );
  });

  it("emits multiple roots flat at depth 0", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "list", name: "A" }),
      mk({ index: 1, role: "grid", name: "B" }),
    ]), null);
    expect(body(out)).toBe(`- list "A" [ref=@e0]\n- grid "B" [ref=@e1]`);
  });

  it("promotes orphan to root when parentIndex missing (truncation safety)", () => {
    const out = renderObserveTree(base([
      mk({ index: 5, role: "button", name: "X", parentIndex: 99 }),
    ]), null);
    expect(body(out)).toBe(`- button "X" [ref=@e5]`);
  });

  it("renders link /url property line as a child", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "link", name: "京东", href: "//jd.com/", reactClickable: true }),
    ]), null);
    expect(body(out)).toBe(`- link "京东" [ref=@e0] [cursor=pointer]:\n  - /url: //jd.com/`);
  });

  it("keeps state flags + value + propagates hash to ref", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "菜单", state: { haspopup: "menu", expanded: true } }),
      mk({ index: 1, role: "slider", name: "音量", valueNow: "30", parentIndex: 0 }),
    ]), "a3f7");
    expect(body(out)).toBe(
      `- button "菜单" [ref=@a3f7:e0] [expanded] [haspopup:menu]:\n` +
      `  - slider "音量" [ref=@a3f7:e1] value=30`
    );
  });

  it("emits bbox when includeBoxes", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "Q", bbox: [1, 2, 3, 4] }),
    ]), null, true);
    expect(body(out)).toContain(`- button "Q" [ref=@e0] bbox=[1,2,3,4]`);
  });
});
