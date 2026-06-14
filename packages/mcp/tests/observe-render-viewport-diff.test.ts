/**
 * T4 新增：viewport [offscreen] 标记 + N more 汇总提示 + prevSnapshotId diff 新元素 * 前缀。
 *
 * 测试先行（TDD：RED → GREEN 流程）。
 */
import { describe, it, expect } from "vitest";
import { renderObserveTree, renderObserveCompact, storeSnapshot } from "../src/lib/observe-render.js";
import type { CompactElement } from "../src/lib/observe-render.js";

// --- 辅助工厂 ---
const mk = (o: Partial<CompactElement> & { index: number; role: string }): CompactElement => ({
  tag: "div",
  name: "",
  frameId: 0,
  ...o,
} as CompactElement);

const base = (els: CompactElement[], extras: Record<string, unknown> = {}) => ({
  snapshotId: "snap_a1",
  url: "http://t",
  elements: els,
  ...extras,
});

// =========================================================
// 子项 A：[offscreen] 标记 + N more 汇总
// =========================================================
describe("renderObserveTree — viewport 标记 (子项 A)", () => {
  it("视口内元素不带 [offscreen]", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "保存", inViewport: true }),
    ]), null);
    expect(out).not.toContain("[offscreen]");
  });

  it("视口外元素带 [offscreen] 标记", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "加载更多", inViewport: false }),
    ]), null);
    expect(out).toContain("[offscreen]");
  });

  it("inViewport 未设置时不打 [offscreen]（兼容旧数据）", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "兼容" }),
    ]), null);
    expect(out).not.toContain("[offscreen]");
  });

  it("N more below 提示：仅统计屏外可交互元素（offScreenActionable）", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "可见1", inViewport: true }),
      mk({ index: 1, role: "button", name: "屏外1", inViewport: false, offScreenActionable: true }),
      mk({ index: 2, role: "button", name: "屏外2", inViewport: false, offScreenActionable: true }),
      mk({ index: 3, role: "button", name: "视觉隐藏", inViewport: false, offScreenActionable: false }),
    ]), null);
    // 2 个 offScreenActionable 元素
    expect(out).toContain("2 more below — scroll to reveal");
  });

  it("无屏外可交互元素时不输出 N more 提示", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "只有可见", inViewport: true }),
    ]), null);
    expect(out).not.toContain("more below");
  });

  it("compact 模式同样支持 [offscreen] 和 N more 提示", () => {
    const out = renderObserveCompact(base([
      mk({ index: 0, role: "button", name: "屏外", inViewport: false, offScreenActionable: true }),
    ]), null);
    expect(out).toContain("[offscreen]");
    expect(out).toContain("1 more below — scroll to reveal");
  });
});

// =========================================================
// 子项 B：prevSnapshotId diff 新元素 * 前缀
// =========================================================
describe("renderObserveTree — prevSnapshotId diff (子项 B)", () => {
  it("不传 prevSnapshotId 时行为完全不变", () => {
    const out = renderObserveTree(base([
      mk({ index: 0, role: "button", name: "保存" }),
    ]), null);
    // 无 * 前缀
    expect(out).not.toContain("*");
  });

  it("传 prevSnapshotId + 新增元素打 * 前缀（tree 模式）", () => {
    // 先存一个基准快照
    const prevId = "snap_prev_001";
    storeSnapshot(prevId, [
      { elementKey: "button::保存::0", index: 0 },
    ]);

    const out = renderObserveTree({
      snapshotId: "snap_curr_002",
      url: "http://t",
      prevSnapshotId: prevId,
      elements: [
        mk({ index: 0, role: "button", name: "保存" }),          // 已存在 → 不打 *
        mk({ index: 1, role: "dialog", name: "确认弹窗" }),       // 新增 → 打 *
      ],
    } as any, null);

    // 旧元素不打 *
    expect(out).not.toMatch(/\* .* button "保存"/);
    // 新元素打 *
    expect(out).toContain('* - dialog "确认弹窗"');
  });

  it("传 prevSnapshotId + 新增元素打 * 前缀（compact 模式）", () => {
    const prevId = "snap_prev_002";
    storeSnapshot(prevId, [
      { elementKey: "button::提交::0", index: 0 },
    ]);

    const out = renderObserveCompact({
      snapshotId: "snap_curr_003",
      url: "http://t",
      prevSnapshotId: prevId,
      elements: [
        mk({ index: 0, role: "button", name: "提交" }),       // 已存在
        mk({ index: 1, role: "alert", name: "操作成功" }),     // 新增
      ],
    } as any, null);

    expect(out).not.toMatch(/\*.*button.*提交/);
    expect(out).toContain("* ");
    expect(out).toContain('[alert] "操作成功"');
  });

  it("prevSnapshotId 不存在（已过期或首次）时退化为无 diff（不报错）", () => {
    const out = renderObserveTree({
      snapshotId: "snap_curr_004",
      url: "http://t",
      prevSnapshotId: "snap_nonexistent_999",
      elements: [
        mk({ index: 0, role: "button", name: "按钮" }),
      ],
    } as any, null);
    // 不崩溃，不打 *，元素正常渲染
    expect(out).not.toContain("*");
    expect(out).toContain('button "按钮"');
  });

  it("当次 observe 结束后自动存储快照供下次 diff 使用", () => {
    // renderObserveTree 调用后，下次用该 snapshotId 能取到快照
    const snapshotId = "snap_auto_store_001";
    renderObserveTree({
      snapshotId,
      url: "http://t",
      elements: [
        mk({ index: 0, role: "button", name: "自动存储" }),
      ],
    } as any, null);

    // 下一次 observe 以该 snapshotId 为 prevSnapshotId
    const out = renderObserveTree({
      snapshotId: "snap_auto_store_002",
      url: "http://t",
      prevSnapshotId: snapshotId,
      elements: [
        mk({ index: 0, role: "button", name: "自动存储" }),  // 已存在
        mk({ index: 1, role: "dialog", name: "新弹窗" }),    // 新增
      ],
    } as any, null);

    expect(out).toContain('* - dialog "新弹窗"');
    expect(out).not.toMatch(/\* .*button.*自动存储/);
  });
});
