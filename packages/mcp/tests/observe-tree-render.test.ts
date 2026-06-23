import { describe, it, expect } from "vitest";
import { renderObserveTree } from "../src/lib/observe-render.js";
import type { CompactElement } from "../src/lib/observe-render.js";

const mk = (o: Partial<CompactElement> & { index: number; role: string }): CompactElement => ({
  tag: "div", name: "", frameId: 0, ...o,
} as CompactElement);

function body(out: string): string {
  // 跳过 header（SnapshotId/URL/Title/Viewport + 空行），只取树体
  const parts = out.split("\n");
  return parts.slice(parts.indexOf("") + 1).join("\n");
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

  it("emits frame note for a not-scanned frame", () => {
    const out = renderObserveTree({
      snapshotId: "snap_x", url: "http://t",
      frames: [
        { frameId: 0, parentFrameId: -1, url: "http://t", offset: { x: 0, y: 0 }, elementCount: 1, truncated: false, scanned: true },
        { frameId: 2, parentFrameId: 0, url: "http://cross", offset: { x: 0, y: 0 }, elementCount: 0, truncated: false, scanned: false },
      ],
      elements: [mk({ index: 0, role: "button", name: "Q" })],
    } as any, null);
    expect(out).toContain("# frame 2 not scanned (url=http://cross)");
  });

  it("promotes self-loop parentIndex to root", () => {
    const out = renderObserveTree(base([
      mk({ index: 3, role: "button", name: "Self", parentIndex: 3 }),
    ]), null);
    expect(body(out)).toBe(`- button "Self" [ref=@e3]`);
  });

  // 拖拽源信号:[draggable] 与投放区 [dropzone] 正交对称——前者是 vortex_drag 的
  // startRef 源(能被拖起),后者是 endRef 目标(接受投放)。HTML5 draggable=true 控件
  // (看板卡片/文件管理器/sortable)入池后此前无任何拖拽源标识,agent 无法区分它和
  // 普通 group 容器(2026-06-23 the-internet/drag_and_drop + SortableJS 评测)。
  it("draggableInteractive → [draggable] 拖拽源标记(vortex_drag startRef 目标)", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "group", name: "看板卡片", draggableInteractive: true }),
    ]), null);
    expect(body(out)).toBe(`- group "看板卡片" [ref=@e0] [draggable]`);
  });

  it("draggable 与 dropzone 正交共存(the-internet A/B 既可拖起又可投放)", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "group", name: "A", draggableInteractive: true, dropzoneInteractive: true }),
    ]), null);
    expect(body(out)).toBe(`- group "A" [ref=@e0] [dropzone] [draggable]`);
  });

  it("无 draggableInteractive 不打 [draggable](避免噪声)", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "普通按钮" }),
    ]), null);
    expect(body(out)).not.toContain("[draggable]");
  });
});
