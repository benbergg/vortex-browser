// packages/vortex-bench/tests/geometry-join.test.ts
import { describe, it, expect } from "vitest";
import { centerInside, joinByGeometry, boxesMatch } from "../src/runner/geometry-join.js";
import type { ObserveRow, OracleRect } from "../src/scan-types.js";

function row(ref: string, bbox: ObserveRow["bbox"]): ObserveRow {
  return { ref, role: "button", name: "x", flags: [], bbox, frameId: 0 };
}

describe("centerInside", () => {
  it("bbox 中心落在 rect 内 → true", () => {
    expect(centerInside([10, 10, 20, 20], [0, 0, 100, 100])).toBe(true); // center 20,20
  });
  it("bbox 中心在 rect 外 → false", () => {
    expect(centerInside([200, 200, 20, 20], [0, 0, 100, 100])).toBe(false);
  });
});

// boxesMatch 不再被 judge-consistency / judge-calibrate 调用(已切 label-based),
// 但函数本身保留作 utility(future 可能用于同坐标系 bbox 对齐场景)。
describe("boxesMatch (utility,judge 路径已切 label-based)", () => {
  it("中心互落入 → true", () => {
    expect(boxesMatch([0, 0, 100, 100], [10, 10, 80, 80])).toBe(true);
  });
  it("完全不相交 → false", () => {
    expect(boxesMatch([0, 0, 10, 10], [500, 500, 10, 10])).toBe(false);
  });
});

describe("joinByGeometry", () => {
  it("行中心落在 oracle rect → 配对", () => {
    const rows = [row("@e0", [10, 10, 20, 20])];
    const oracles: OracleRect[] = [{ id: "a", rect: [0, 0, 100, 100] }];
    const { matches, unmatchedRows } = joinByGeometry(rows, oracles, {});
    expect(matches.get("a")?.[0].ref).toBe("@e0");
    expect(unmatchedRows).toHaveLength(0);
  });

  it("无 oracle 命中 → unmatchedRows", () => {
    const rows = [row("@e0", [500, 500, 10, 10])];
    const oracles: OracleRect[] = [{ id: "a", rect: [0, 0, 100, 100] }];
    const { matches, unmatchedRows } = joinByGeometry(rows, oracles, {});
    expect(matches.get("a") ?? []).toHaveLength(0);
    expect(unmatchedRows).toHaveLength(1);
  });

  it("子 frame 行加 offset 后再判定", () => {
    // 行 frame-local bbox 中心 (10,10);frame 1 offset [40,400] → top-page (50,410)
    const rows: ObserveRow[] = [{ ref: "@f1e0", role: "link", name: "x", flags: [], bbox: [5, 5, 10, 10], frameId: 1 }];
    const oracles: OracleRect[] = [{ id: "if", rect: [40, 400, 100, 100] }];
    const { matches } = joinByGeometry(rows, oracles, { 1: [40, 400] });
    expect(matches.get("if")?.[0].ref).toBe("@f1e0");
  });

  it("无 bbox 的行被跳过(不参与几何 join)", () => {
    const rows = [row("@e0", null)];
    const oracles: OracleRect[] = [{ id: "a", rect: [0, 0, 100, 100] }];
    const { matches, unmatchedRows } = joinByGeometry(rows, oracles, {});
    expect(matches.get("a") ?? []).toHaveLength(0);
    expect(unmatchedRows).toHaveLength(0); // 无 bbox 不算 noise,交给 INV-4
  });
});
