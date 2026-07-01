import { describe, it, expect } from "vitest";
import { serializeSheet, readLakeSheetModel, type NormalizedSheet } from "../src/page-side/sheet-readback.js";

// 纵向合并(colCount=1,rowCount=3):锚值只在 row1,covered row2/row3 为空 → markdown 应 fill-down
const verticalMerge: NormalizedSheet = {
  name: "S", rowCount: 4, colCount: 2,
  cells: [
    ["类别", "值"],
    ["A", "x"],
    ["", "y"],
    ["", "z"],
  ],
  merges: [{ row: 1, col: 0, rowCount: 3, colCount: 1 }],
};

describe("serializeSheet markdown 合并混合策略", () => {
  it("纵向合并 fill-down:被覆盖格补锚值", () => {
    const md = serializeSheet(verticalMerge, { format: "markdown", maxRows: 200 });
    const lines = md.split("\n");
    expect(lines[0]).toBe("| 类别 | 值 |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| A | x |");
    expect(lines[3]).toBe("| A | y |");
    expect(lines[4]).toBe("| A | z |");
  });
});

const horizontalMerge: NormalizedSheet = {
  name: "H", rowCount: 2, colCount: 3,
  cells: [["标题", "", ""], ["a", "b", "c"]],
  merges: [{ row: 0, col: 0, rowCount: 1, colCount: 3 }],
};
const pipeCell: NormalizedSheet = {
  name: "P", rowCount: 1, colCount: 1,
  cells: [["a|b\nc"]], merges: [],
};

describe("serializeSheet 其他", () => {
  it("横向合并保持锚点+空(不刷重复)", () => {
    const md = serializeSheet(horizontalMerge, { format: "markdown", maxRows: 200 });
    const lines = md.split("\n");
    expect(lines[0]).toBe("| 标题 |  |  |");
    expect(lines[2]).toBe("| a | b | c |");
  });
  it("转义 `|` 与换行", () => {
    const md = serializeSheet(pipeCell, { format: "markdown", maxRows: 200 });
    expect(md.split("\n")[0]).toBe("| a\\|b c |");
  });
  it("行截断 + 总数标注", () => {
    const big: NormalizedSheet = {
      name: "B", rowCount: 5, colCount: 1,
      cells: [["h"], ["1"], ["2"], ["3"], ["4"]], merges: [],
    };
    const md = serializeSheet(big, { format: "markdown", maxRows: 3 });
    const lines = md.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[lines.length - 1]).toContain("显示 1–3 / 共 5 行");
  });
  it("csv 输出 + 逗号字段转义", () => {
    const s: NormalizedSheet = { name: "C", rowCount: 1, colCount: 2, cells: [["a,b", "c"]], merges: [] };
    expect(serializeSheet(s, { format: "csv", maxRows: 200 }).split("\n")[0]).toBe('"a,b",c');
  });
  it("json 保留精确 merges + 原始网格(不 fill-down)", () => {
    const j = JSON.parse(serializeSheet(verticalMerge, { format: "json", maxRows: 200 }));
    expect(j.rows[2]).toEqual(["", "y"]);
    expect(j.merges).toEqual([{ row: 1, col: 0, rowCount: 3, colCount: 1 }]);
    expect(j.rowCount).toBe(4);
  });
  it("空表", () => {
    const e: NormalizedSheet = { name: "E", rowCount: 0, colCount: 0, cells: [], merges: [] };
    expect(serializeSheet(e, { format: "markdown", maxRows: 200 })).toContain("空表");
  });
});

// 合成内核:仿 model.data(维度+合并) + model.table(2D {value} 网格)
const fakeKernel = {
  model: {
    data: {
      name: "样本表", rowCount: 3, colCount: 2,
      mergeCells: { "1:0": { row: 1, col: 0, rowCount: 2, colCount: 1 } },
    },
    table: [
      [{ value: "订单号" }, { value: "情感" }],
      [{ value: "A" }, { value: "好评" }],
      [{}, { value: "差评" }],
    ],
  },
};

describe("readLakeSheetModel 归一化", () => {
  it("model.data/table → NormalizedSheet(cellText=value ?? '')", () => {
    const s = readLakeSheetModel(fakeKernel, "*");
    expect(s).not.toBeNull();
    expect(s!.name).toBe("样本表");
    expect(s!.rowCount).toBe(3);
    expect(s!.colCount).toBe(2);
    expect(s!.cells).toEqual([
      ["订单号", "情感"],
      ["A", "好评"],
      ["", "差评"],
    ]);
    expect(s!.merges).toEqual([{ row: 1, col: 0, rowCount: 2, colCount: 1 }]);
  });
  it("内核无 model → null", () => {
    expect(readLakeSheetModel({}, "*")).toBeNull();
  });
});
