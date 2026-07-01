// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { serializeSheet, readLakeSheetModel, readWorksheetTabs, type NormalizedSheet } from "../src/page-side/sheet-readback.js";

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

  it("富单元格:图片 value → markdown 图片(非 [object Object])", () => {
    const k = {
      model: {
        data: { name: "I", rowCount: 1, colCount: 2, mergeCells: {} },
        table: [[{ value: "订单" }, { value: { class: "image", src: "https://cdn/x.png", name: "x.png" } }]],
      },
    };
    const s = readLakeSheetModel(k, "*")!;
    expect(s.cells[0][1]).toBe("![x.png](https://cdn/x.png)");
  });

  it("去尾部全空行/列:分配大网格仅裁到内容边界", () => {
    const k = {
      model: {
        data: { name: "T", rowCount: 5, colCount: 4, mergeCells: {} },
        table: [
          [{ value: "h" }, { value: "v" }, {}, {}],
          [{ value: "a" }, { value: "b" }, {}, {}],
          [{}, {}, {}, {}],
          [{}, {}, {}, {}],
          [{}, {}, {}, {}],
        ],
      },
    };
    const s = readLakeSheetModel(k, "*")!;
    expect(s.rowCount).toBe(2);        // 5 行 → 裁到 2 行有内容
    expect(s.colCount).toBe(2);        // 4 列 → 裁到 2 列有内容
    expect(s.cells).toEqual([["h", "v"], ["a", "b"]]);
  });
});

describe("readWorksheetTabs 工作簿页签枚举", () => {
  it("读页签名 + 活动标记", () => {
    document.body.innerHTML = `
      <div class="lake-sheet-tab-item"><span class="sheet-name-container">好评</span></div>
      <div class="lake-sheet-tab-item lake-sheet-tab-item-active"><span class="sheet-name-container">历史宝洁</span></div>
      <div class="lake-sheet-tab-item"><span class="sheet-name-container">备用样本</span></div>`;
    expect(readWorksheetTabs(document)).toEqual([
      { name: "好评", active: false },
      { name: "历史宝洁", active: true },
      { name: "备用样本", active: false },
    ]);
  });
  it("无页签 → 空数组", () => {
    document.body.innerHTML = `<div>x</div>`;
    expect(readWorksheetTabs(document)).toEqual([]);
  });
});

describe("serializeSheet 工作簿清单行", () => {
  it("markdown 追加工作簿清单(>1 sheet,标当前)", () => {
    const s: NormalizedSheet = {
      name: "历史宝洁", rowCount: 1, colCount: 1, cells: [["h"]], merges: [],
      worksheets: [{ name: "好评", active: false }, { name: "历史宝洁", active: true }],
    };
    const last = serializeSheet(s, { format: "markdown", maxRows: 200 }).split("\n").pop()!;
    expect(last).toContain("工作簿(2)");
    expect(last).toContain("*历史宝洁"); // 当前 sheet 标星
    expect(last).toContain("好评");
    expect(last).toContain("mode=sheet"); // 切换指引
  });
  it("单 sheet 或无 worksheets → 不追加清单行", () => {
    const s: NormalizedSheet = { name: "S", rowCount: 1, colCount: 1, cells: [["h"]], merges: [] };
    expect(serializeSheet(s, { format: "markdown", maxRows: 200 })).not.toContain("工作簿(");
  });
});
