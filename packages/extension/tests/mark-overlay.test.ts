// P1-3 薄视觉兑底(Set-of-Mark):computeMarkPlacements 纯几何逻辑单测。
// 把 observe 快照 index→bbox(viewport 相对 CSS px)映射到截图像素坐标,
// 供 OffscreenCanvas 叠加 ref 编号(截图号=DOM ref)。canvas draw 在真浏览器 live 验。

import { describe, it, expect } from "vitest";
import { computeMarkPlacements, type MarkRect } from "../src/lib/mark-overlay.js";

const r = (index: number, x: number, y: number, w: number, h: number, inViewport = true): MarkRect => ({
  index,
  x,
  y,
  w,
  h,
  inViewport,
});

describe("computeMarkPlacements", () => {
  it("dpr=1 时坐标原样透传(clamp 内)", () => {
    const out = computeMarkPlacements([r(3, 10, 20, 100, 40)], 1, 800, 600);
    expect(out).toEqual([{ index: 3, x: 10, y: 20, w: 100, h: 40 }]);
  });

  it("dpr=2 时 bbox 整体 ×2(对齐 captureVisibleTab 物理像素图)", () => {
    const out = computeMarkPlacements([r(5, 10, 20, 100, 40)], 2, 1600, 1200);
    expect(out).toEqual([{ index: 5, x: 20, y: 40, w: 200, h: 80 }]);
  });

  it("过滤视口外元素(inViewport=false 不叠标)", () => {
    const out = computeMarkPlacements([r(1, 0, 0, 50, 50, false)], 1, 800, 600);
    expect(out).toEqual([]);
  });

  it("过滤零/负尺寸元素(display:none / 退化 box)", () => {
    const out = computeMarkPlacements(
      [r(1, 10, 10, 0, 40), r(2, 10, 10, 50, 0), r(3, 10, 10, -5, 40)],
      1,
      800,
      600,
    );
    expect(out).toEqual([]);
  });

  it("完全落在图像外的 box 丢弃(负坐标越界)", () => {
    const out = computeMarkPlacements([r(1, -200, -200, 50, 50)], 1, 800, 600);
    expect(out).toEqual([]);
  });

  it("部分越界的 box 裁剪到图像边界(标签不出画布)", () => {
    // box 右下超出 800×600:x=780,w=100 → 右边界裁到 800
    const out = computeMarkPlacements([r(7, 780, 580, 100, 100)], 1, 800, 600);
    expect(out).toEqual([{ index: 7, x: 780, y: 580, w: 20, h: 20 }]);
  });

  it("dpr 非法(0/NaN/负)回退为 1", () => {
    expect(computeMarkPlacements([r(1, 10, 20, 30, 40)], 0, 800, 600)).toEqual([
      { index: 1, x: 10, y: 20, w: 30, h: 40 },
    ]);
    expect(computeMarkPlacements([r(1, 10, 20, 30, 40)], Number.NaN, 800, 600)).toEqual([
      { index: 1, x: 10, y: 20, w: 30, h: 40 },
    ]);
  });

  it("多元素保序输出", () => {
    const out = computeMarkPlacements([r(9, 0, 0, 10, 10), r(2, 100, 100, 10, 10)], 1, 800, 600);
    expect(out.map((p) => p.index)).toEqual([9, 2]);
  });
});
