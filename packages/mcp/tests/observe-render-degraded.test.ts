// observe 扫描降级的对外可见性(2026-08-11 CC transcript 日志实证)。
//
// 乙方案契约:有货就交货并标明缺口。extension 侧已在 meta.degraded 记录被跳过的
// frame,但渲染层若不输出,agent 只看到"少了几个元素"却不知道为什么 —— 就退化成
// silent success(拿到部分结果当全部用)。
//
// 缺口必须出现在 compact 文本里,因为 LLM 读的是文本不是 JSON。

import { describe, it, expect } from "vitest";
import { renderObserveTree, renderObserveCompact } from "../src/lib/observe-render.js";

function obs(elements: any[], extra: any = {}) {
  return { snapshotId: "s1", url: "http://x", elements, ...extra };
}

const oneEl = [{ index: 0, tag: "button", role: "button", name: "OK", frameId: 0 }];

describe("observe 降级 meta 行", () => {
  it("tree: 超时 frame 渲染 # degraded 行,含 frameId", () => {
    const out = renderObserveTree(
      obs(oneEl, { meta: { degraded: { timedOutFrames: [190] } } }),
      null,
    );
    expect(out).toContain("# degraded:");
    expect(out).toContain("190");
  });

  it("compact: 超时 frame 渲染 # degraded 行", () => {
    const out = renderObserveCompact(
      obs(oneEl, { meta: { degraded: { timedOutFrames: [190] } } }),
      null,
    );
    expect(out).toContain("# degraded:");
    expect(out).toContain("190");
  });

  it("预算跳过的 frame 也进 # degraded 行", () => {
    const out = renderObserveTree(
      obs(oneEl, { meta: { degraded: { budgetSkippedFrames: [7, 8] } } }),
      null,
    );
    expect(out).toContain("# degraded:");
    expect(out).toContain("7");
    expect(out).toContain("8");
  });

  it("降级行提示如何补救(缩小 frames 范围)", () => {
    const out = renderObserveTree(
      obs(oneEl, { meta: { degraded: { timedOutFrames: [190] } } }),
      null,
    );
    expect(out).toMatch(/frames=|frames='main'/);
  });

  // 这两项不减少元素数量,但静默降低召回/语义质量:listener 丢失 → vanilla/jQuery
  // 裸 div 按钮不再被发现;AX overlay 丢失 → role/name 退回启发式。不显式说明,agent
  // 会把"元素看起来齐全"当成结果可信。
  it("listener discovery 超时渲染进 # degraded,并说明召回影响", () => {
    const out = renderObserveTree(
      obs(oneEl, { meta: { degraded: { listenerDiscovery: "timeout" } } }),
      null,
    );
    expect(out).toContain("# degraded:");
    expect(out).toMatch(/listener/i);
  });

  it("AX overlay 超时渲染进 # degraded", () => {
    const out = renderObserveTree(
      obs(oneEl, { meta: { degraded: { axOverlay: "timeout" } } }),
      null,
    );
    expect(out).toContain("# degraded:");
    expect(out).toMatch(/role|name|AX/i);
  });

  it("无降级时不出现 # degraded(负例,保证正常路径字节不变)", () => {
    const out = renderObserveTree(obs(oneEl, { meta: { frameCount: 1, scannedFrames: 1 } }), null);
    expect(out).not.toContain("degraded");
  });
});
