# 语雀 Lake Sheet readback 实现计划（`vortex_query mode=sheet`）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `vortex_query mode=sheet` 把语雀 Lake Sheet（canvas 电子表格）的数据以结构化 Markdown（默认，可切 csv/json）读出，并让 observe 的盲区行指向它。

**Architecture:** 新增一个 page-side probe 函数 `sheetProbeFunc`（与 `geometryProbeFunc`/`styleProbeFunc` 同构，注入 MAIN world），fiber 走访拿 LakeSheet 内核的已解析内存模型（`kernel.model.data` + `.table`），归一化为 `NormalizedSheet` 后序列化。核心逻辑落在真源 `sheet-readback.ts`（纯函数可离线单测），probe 函数按 vortex 惯例内联同一逻辑（注入丢模块作用域），parity 断言守"改一处须改两处"。observe 侧加 lake-sheet 帧级盲区识别 + 指路渲染。

**Tech Stack:** TypeScript、Chrome MV3 `chrome.scripting.executeScript({world:"MAIN"})`、React fiber 内省、Vitest（jsdom）。

## Global Constraints

- **注释语言中文**（代码标识符/API 名保留英文）；**禁止** `Co-Authored-By`/`Signed-off-by` 署名。
- **提交走 Conventional Commits**（`type: 中文描述`，动词开头，结尾无句号）——用 git-commit skill 规范。
- **page-side 注入函数必须自包含**：`sheetProbeFunc` 内联所有 helper（注入丢模块作用域 → 引用模块级符号会 `X is not defined`）；真源与内联副本用 parity 断言同步（既有模式：`[inline detectChartCanvas]` 等）。
- **只读安全**：全程纯读，不调用任何 LakeSheet 写命令（不碰 `kernel.command`/`history`/`ot`）。
- **MCP tools/list ≤ 8000 字节**（I15 预算）——mode enum 加 `sheet` + 描述微调后必须回归该断言。
- **不新增 query schema 字段**：复用 `pattern`（sheet 选择器）、`attr`（格式）、`maxResults`（行上限）。
- **分工**（见 [[vortex_opencode_m3_tmux_sop]]）：Task 1（纯序列化器）可派 M3；Task 2–4（fiber 走访/probe 承重墙/observe 集成/真站 live）orchestrator 自留。并发铁律：`sheet-readback.ts` 被 Task 1/2 先后编辑，须 Task 1 提交后 Task 2 再接手。

---

### Task 1: `NormalizedSheet` 类型 + `serializeSheet` 纯序列化器

真源纯函数：`NormalizedSheet`（归一化模型）→ Markdown / CSV / JSON 文本。承载合并混合策略 + 转义 + 行截断 + 格式分派。**纯函数、零浏览器依赖、可离线单测打透**——这是 load-bearing 逻辑。**可派 M3。**

**Files:**
- Create: `packages/extension/src/page-side/sheet-readback.ts`
- Test: `packages/extension/tests/sheet-readback.test.ts`

**Interfaces:**
- Produces:
  - `interface NormalizedSheet { name: string; rowCount: number; colCount: number; cells: string[][]; merges: Merge[]; }`
  - `interface Merge { row: number; col: number; rowCount: number; colCount: number; }`
  - `type SheetFormat = "markdown" | "csv" | "json";`
  - `function serializeSheet(sheet: NormalizedSheet, opts: { format: SheetFormat; maxRows: number }): string`
  - 约定：`sheet.cells` 是**锚点+空的原始网格**（合并被覆盖格为 `""`，值只在左上锚点）；`serializeSheet` 对 markdown/csv 施加混合策略（纵向合并 fill-down、横向合并保持锚点+空），json 保留原始网格 + 精确 `merges`。

- [ ] **Step 1: 写失败测试（纵向合并 fill-down）**

`packages/extension/tests/sheet-readback.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { serializeSheet, type NormalizedSheet } from "../src/page-side/sheet-readback.js";

// 纵向合并(colCount=1,rowCount=3):锚值只在 row1,covered row2/row3 为空 → markdown 应 fill-down
const verticalMerge: NormalizedSheet = {
  name: "S", rowCount: 4, colCount: 2,
  cells: [
    ["类别", "值"],
    ["A", "x"],
    ["", "y"],   // (2,0) 被 (1,0) 纵向合并覆盖
    ["", "z"],   // (3,0) 同上
  ],
  merges: [{ row: 1, col: 0, rowCount: 3, colCount: 1 }],
};

describe("serializeSheet markdown 合并混合策略", () => {
  it("纵向合并 fill-down:被覆盖格补锚值", () => {
    const md = serializeSheet(verticalMerge, { format: "markdown", maxRows: 200 });
    const lines = md.split("\n");
    // 表头 + 分隔 + 4 数据行... header 行是 cells[0]
    expect(lines[0]).toBe("| 类别 | 值 |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| A | x |");
    expect(lines[3]).toBe("| A | y |");   // fill-down
    expect(lines[4]).toBe("| A | z |");   // fill-down
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/sheet-readback.test.ts`
Expected: FAIL —「serializeSheet is not a function」/ 模块不存在。

- [ ] **Step 3: 最小实现**

`packages/extension/src/page-side/sheet-readback.ts`：

```typescript
/**
 * 语雀 Lake Sheet 结构化 readback 真源(纯逻辑)。
 * NormalizedSheet 是从 LakeSheet 内存模型归一化后的中间形态(见 Task 2 readLakeSheetModel):
 * cells = 锚点+空的原始网格(合并被覆盖格为 ""),merges = 精确 span 列表。
 * serializeSheet 施加合并混合策略 + 转义 + 行截断 + 格式分派。
 * ⚠ page-side probe(query.ts sheetProbeFunc)内联同一逻辑(注入丢模块作用域),
 * 改一处须改两处;query-sheet-parity.test.ts 校验。
 */
export interface Merge { row: number; col: number; rowCount: number; colCount: number; }
export interface NormalizedSheet {
  name: string;
  rowCount: number;
  colCount: number;
  cells: string[][];
  merges: Merge[];
}
export type SheetFormat = "markdown" | "csv" | "json";

/** markdown 单元格转义:`|`→`\|`、换行→空格、裁首尾空白。 */
function escMd(s: string): string {
  return String(s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** CSV 字段转义(RFC 4180):含 `"`/`,`/换行 → 包双引号并把 `"` 转义为 `""`。 */
function escCsv(s: string): string {
  const v = String(s ?? "");
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/**
 * 混合策略:返回一个新网格,对**纵向合并**(colCount===1 && rowCount>1)把锚值 fill-down
 * 到被覆盖行;**横向合并**(colCount>1)保持原样(锚点+空,不刷)。json 不调用此函数。
 */
function applyMergeFill(cells: string[][], merges: Merge[]): string[][] {
  const grid = cells.map((r) => r.slice());
  for (const m of merges) {
    if (m.colCount === 1 && m.rowCount > 1) {
      const anchor = grid[m.row]?.[m.col] ?? "";
      for (let r = m.row + 1; r < m.row + m.rowCount; r++) {
        if (grid[r] && grid[r][m.col] === "") grid[r][m.col] = anchor;
      }
    }
  }
  return grid;
}

export function serializeSheet(
  sheet: NormalizedSheet,
  opts: { format: SheetFormat; maxRows: number },
): string {
  const total = sheet.cells.length;
  const shown = Math.min(total, Math.max(1, opts.maxRows));
  const truncated = total > shown;

  if (opts.format === "json") {
    return JSON.stringify({
      sheet: sheet.name,
      rowCount: sheet.rowCount,
      colCount: sheet.colCount,
      rows: sheet.cells.slice(0, shown),
      merges: sheet.merges,
      truncated,
    });
  }

  const filled = applyMergeFill(sheet.cells, sheet.merges).slice(0, shown);
  if (filled.length === 0) {
    return `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，空表（sheet: ${sheet.name}）`;
  }

  const lines: string[] = [];
  if (opts.format === "csv") {
    for (const row of filled) lines.push(row.map(escCsv).join(","));
  } else {
    const header = filled[0];
    lines.push("| " + header.map(escMd).join(" | ") + " |");
    lines.push("| " + header.map(() => "---").join(" | ") + " |");
    for (let i = 1; i < filled.length; i++) {
      lines.push("| " + filled[i].map(escMd).join(" | ") + " |");
    }
  }
  const foot = truncated
    ? `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，显示 1–${shown} / 共 ${total} 行，提高 maxResults 取更多（sheet: ${sheet.name}）`
    : `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，显示 1–${shown}（sheet: ${sheet.name}）`;
  lines.push(foot);
  return lines.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/sheet-readback.test.ts`
Expected: PASS（1 例）。

- [ ] **Step 5: 补齐覆盖测试（横向合并 / 转义 / 截断 / csv / json / 空表）**

追加到同测试文件：

```typescript
const horizontalMerge: NormalizedSheet = {
  name: "H", rowCount: 2, colCount: 3,
  cells: [["标题", "", ""], ["a", "b", "c"]],   // (0,0) 横跨 3 列
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
    expect(lines[0]).toBe("| 标题 |  |  |");        // 其余列留空,不重复"标题"
    expect(lines[2]).toBe("| a | b | c |");
  });
  it("转义 `|` 与换行", () => {
    const md = serializeSheet(pipeCell, { format: "markdown", maxRows: 200 });
    expect(md.split("\n")[0]).toBe("| a\\|b c |");   // | → \| ,换行 → 空格
  });
  it("行截断 + 总数标注", () => {
    const big: NormalizedSheet = {
      name: "B", rowCount: 5, colCount: 1,
      cells: [["h"], ["1"], ["2"], ["3"], ["4"]], merges: [],
    };
    const md = serializeSheet(big, { format: "markdown", maxRows: 3 });
    const lines = md.split("\n");
    expect(lines).toHaveLength(3 + 1);   // header + sep + 1 data + footer
    expect(lines[lines.length - 1]).toContain("显示 1–3 / 共 5 行");
  });
  it("csv 输出 + 逗号字段转义", () => {
    const s: NormalizedSheet = { name: "C", rowCount: 1, colCount: 2, cells: [["a,b", "c"]], merges: [] };
    expect(serializeSheet(s, { format: "csv", maxRows: 200 }).split("\n")[0]).toBe('"a,b",c');
  });
  it("json 保留精确 merges + 原始网格(不 fill-down)", () => {
    const j = JSON.parse(serializeSheet(verticalMerge, { format: "json", maxRows: 200 }));
    expect(j.rows[2]).toEqual(["", "y"]);   // 原始锚点+空,未 fill-down
    expect(j.merges).toEqual([{ row: 1, col: 0, rowCount: 3, colCount: 1 }]);
    expect(j.rowCount).toBe(4);
  });
  it("空表", () => {
    const e: NormalizedSheet = { name: "E", rowCount: 0, colCount: 0, cells: [], merges: [] };
    expect(serializeSheet(e, { format: "markdown", maxRows: 200 })).toContain("空表");
  });
});
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `cd packages/extension && pnpm vitest run tests/sheet-readback.test.ts`
Expected: PASS（7 例）。

- [ ] **Step 7: 提交**

```bash
git add packages/extension/src/page-side/sheet-readback.ts packages/extension/tests/sheet-readback.test.ts
git commit -m "feat: 加语雀 sheet readback 纯序列化器(合并混合策略+转义+截断)"
```

---

### Task 2: `locateLakeSheetKernel` + `readLakeSheetModel`（内存模型 → NormalizedSheet）

真源里补上"从页面 LakeSheet 内核读出 `NormalizedSheet`"的浏览器耦合逻辑：fiber 走访定位内核 + 归一化 `model.data`/`model.table` + 提取合并。**orchestrator 自留**（fiber 走访判断需真站校准）；归一化器用合成内核 mock 单测。

**Files:**
- Modify: `packages/extension/src/page-side/sheet-readback.ts`
- Test: `packages/extension/tests/sheet-readback.test.ts`

**Interfaces:**
- Consumes: `NormalizedSheet`, `Merge`（Task 1）。
- Produces:
  - `function locateLakeSheetKernel(doc: Document): any | null` — 从 `.lake-sheet-canvas-container`/`.lake-sheet-editor` fiber `return` 链找 `memoizedState.sheet`（`doc||model`），无则 null。
  - `function readLakeSheetModel(kernel: any, sheetSelector: string): NormalizedSheet | null` — 归一化当前 worksheet；`sheetSelector` 为 `*`/名字子串/索引（v1：非 `*` 尽力匹配，匹配不到回当前 sheet 并把 `name` 标注为实际读到的 sheet）。

- [ ] **Step 1: 写失败测试（归一化器，合成内核 mock）**

追加到 `tests/sheet-readback.test.ts`：

```typescript
import { readLakeSheetModel } from "../src/page-side/sheet-readback.js";

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
      [{}, { value: "差评" }],   // (2,0) 被合并覆盖 → 无 value
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/sheet-readback.test.ts`
Expected: FAIL —「readLakeSheetModel is not a function」。

- [ ] **Step 3: 最小实现**

追加到 `sheet-readback.ts`：

```typescript
/**
 * fiber 走访定位 LakeSheet 内核:从 canvas 容器沿 fiber.return 上升,找 memoizedState.sheet
 * (sig: doc||model)。2026-07-01 真站(banniu.yuque.com)实测路径。
 */
export function locateLakeSheetKernel(doc: Document): any | null {
  const container =
    doc.querySelector(".lake-sheet-canvas-container") || doc.querySelector(".lake-sheet-editor");
  if (!container) return null;
  const fk = Object.keys(container).find(
    (k) => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"),
  );
  if (!fk) return null;
  let fiber: any = (container as any)[fk];
  let depth = 0;
  while (fiber && depth < 40) {
    const st = fiber.memoizedState;
    if (st && st.sheet && (st.sheet.doc || st.sheet.model)) return st.sheet;
    fiber = fiber.return;
    depth++;
  }
  return null;
}

/**
 * 归一化 LakeSheet 内核当前 worksheet → NormalizedSheet。
 * cell 显示文本 = cell?.value ?? ''(非字符串 String 化)。合并从 model.data.mergeCells
 * ({"r:c":{row,col,rowCount,colCount}})转数组。sheetSelector 非 `*` 时的跨 sheet 定位见
 * 计划风险项(v1:仅当前活动 sheet 有硬保证)。
 */
export function readLakeSheetModel(kernel: any, _sheetSelector: string): NormalizedSheet | null {
  const m = kernel && kernel.model;
  const d = m && m.data;
  const table = m && m.table;
  if (!d || !Array.isArray(table)) return null;
  const colCount = typeof d.colCount === "number" ? d.colCount : (table[0] ? table[0].length : 0);
  const cellText = (c: any): string => {
    if (c == null) return "";
    const v = typeof c === "object" ? c.value : c;
    return v == null ? "" : String(v);
  };
  const cells: string[][] = table.map((row: any[]) => {
    const out: string[] = [];
    for (let c = 0; c < colCount; c++) out.push(cellText(row && row[c]));
    return out;
  });
  const merges: Merge[] = [];
  const mc = d.mergeCells;
  if (mc && typeof mc === "object") {
    for (const k of Object.keys(mc)) {
      const v = mc[k];
      if (v && typeof v === "object" && typeof v.row === "number" && typeof v.col === "number") {
        merges.push({ row: v.row, col: v.col, rowCount: v.rowCount ?? 1, colCount: v.colCount ?? 1 });
      }
    }
  }
  return {
    name: typeof d.name === "string" ? d.name : "",
    rowCount: typeof d.rowCount === "number" ? d.rowCount : table.length,
    colCount,
    cells,
    merges,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/sheet-readback.test.ts`
Expected: PASS（9 例：Task 1 的 7 + 本任务 2）。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/sheet-readback.ts packages/extension/tests/sheet-readback.test.ts
git commit -m "feat: 加语雀 LakeSheet 内核定位与模型归一化(fiber→NormalizedSheet)"
```

---

### Task 3: `vortex_query mode=sheet` 端到端接线（probe 内联 + dispatch + schema）

把 `mode=sheet` 接进 query.ts：`sheetProbeFunc`（**内联** locate+read+serialize，注入 MAIN world）+ dispatch case + 参数校验 + MCP schema mode enum/描述 + parity 断言。**orchestrator 自留**，真站 live 验收。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（加 `sheetProbeFunc` + dispatch）
- Modify: `packages/mcp/src/tools/schemas-public.ts:397,393`（mode enum + description）
- Test: `packages/extension/tests/query-sheet-parity.test.ts`（新，parity）
- Test: `packages/mcp/tests/`（tools/list ≤8000 既有断言回归）

**Interfaces:**
- Consumes: 真源 `serializeSheet`/`locateLakeSheetKernel`/`readLakeSheetModel`（Task 1/2）——**逻辑内联**进 `sheetProbeFunc`（不 import，注入丢作用域）。
- Produces: `sheetProbeFunc(pattern: string, format: string, maxRows: number)` 返回 `{ text: string } | { error: string }`。

- [ ] **Step 1: 写失败测试（parity 断言：内联副本含真源关键字符串）**

`packages/extension/tests/query-sheet-parity.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/handlers/query.ts"), "utf8");

describe("sheetProbeFunc 内联 ↔ sheet-readback 真源 parity", () => {
  it("query.ts 含 [inline sheet-readback] 标记", () => {
    expect(src).toContain("[inline sheet-readback]");
  });
  it("内联含 fiber 定位关键判据(与真源一致)", () => {
    expect(src).toContain(".lake-sheet-canvas-container");
    expect(src).toContain("st.sheet && (st.sheet.doc || st.sheet.model)");
  });
  it("内联含合并混合策略 + 转义(与真源一致)", () => {
    expect(src).toContain("m.colCount === 1 && m.rowCount > 1"); // 纵向 fill-down 判据
    expect(src).toContain('replace(/\\|/g, "\\\\|")');            // markdown `|` 转义
  });
  it("内联含 cell 取值契约 value ?? ''", () => {
    expect(src).toContain("c.value");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/query-sheet-parity.test.ts`
Expected: FAIL —「[inline sheet-readback] 未找到」。

- [ ] **Step 3: 加 `sheetProbeFunc`（自包含内联）**

在 `packages/extension/src/handlers/query.ts` 的 `styleProbeFunc` 之后插入。**全部逻辑内联**（locate + read + serialize，逐字对齐真源 Task 1/2）：

```typescript
/**
 * page-side 语雀 Lake Sheet readback 函数体。mode=sheet 注入 MAIN world。
 * 参数 args: [pattern(sheet 选择器), format(markdown|csv|json), maxRows]。
 * 返回 { text } 或 { error }。⚠ [inline sheet-readback]:注入丢模块作用域,locate/read/
 * serialize 必须内联;逻辑须与 src/page-side/sheet-readback.ts 真源一致(改一处须改两处),
 * query-sheet-parity.test.ts 校验。纯读,不碰 kernel.command/history/ot(只读安全)。
 */
export const sheetProbeFunc = (
  pattern: string,
  format: string,
  maxRows: number,
): { text: string } | { error: string } => {
  try {
    const doc = document;
    const container =
      doc.querySelector(".lake-sheet-canvas-container") || doc.querySelector(".lake-sheet-editor");
    if (!container) return { error: "no lake-sheet on page (未找到语雀数据表；若确在表格页请等待加载，或用 vortex_screenshot)" };
    const fk = Object.keys(container).find(
      (k) => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"),
    );
    if (!fk) return { error: "lake-sheet found but no react fiber (未加载完成，稍后重试或 vortex_screenshot)" };
    let fiber: any = (container as any)[fk];
    let depth = 0;
    let kernel: any = null;
    while (fiber && depth < 40) {
      const st = fiber.memoizedState;
      if (st && st.sheet && (st.sheet.doc || st.sheet.model)) { kernel = st.sheet; break; }
      fiber = fiber.return; depth++;
    }
    if (!kernel) return { error: "lake-sheet kernel not found (fiber 走访失败，稍后重试或 vortex_screenshot)" };

    const m = kernel.model, d = m && m.data, table = m && m.table;
    if (!d || !Array.isArray(table)) return { error: "lake-sheet model empty" };
    const colCount = typeof d.colCount === "number" ? d.colCount : (table[0] ? table[0].length : 0);
    const cellText = (c: any): string => {
      if (c == null) return "";
      const v = typeof c === "object" ? c.value : c;
      return v == null ? "" : String(v);
    };
    const cells: string[][] = table.map((row: any[]) => {
      const out: string[] = [];
      for (let c = 0; c < colCount; c++) out.push(cellText(row && row[c]));
      return out;
    });
    const merges: Array<{ row: number; col: number; rowCount: number; colCount: number }> = [];
    const mc = d.mergeCells;
    if (mc && typeof mc === "object") {
      for (const k of Object.keys(mc)) {
        const v = mc[k];
        if (v && typeof v === "object" && typeof v.row === "number" && typeof v.col === "number") {
          merges.push({ row: v.row, col: v.col, rowCount: v.rowCount ?? 1, colCount: v.colCount ?? 1 });
        }
      }
    }
    const sheet = {
      name: typeof d.name === "string" ? d.name : "",
      rowCount: typeof d.rowCount === "number" ? d.rowCount : table.length,
      colCount, cells, merges,
    };

    // —— serialize(内联真源 serializeSheet)——
    const escMd = (s: string): string => String(s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
    const escCsv = (s: string): string => {
      const v = String(s ?? "");
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const applyMergeFill = (cs: string[][], ms: typeof merges): string[][] => {
      const grid = cs.map((r) => r.slice());
      for (const m2 of ms) {
        if (m2.colCount === 1 && m2.rowCount > 1) {
          const anchor = grid[m2.row]?.[m2.col] ?? "";
          for (let r = m2.row + 1; r < m2.row + m2.rowCount; r++) {
            if (grid[r] && grid[r][m2.col] === "") grid[r][m2.col] = anchor;
          }
        }
      }
      return grid;
    };
    const fmt = format === "csv" || format === "json" ? format : "markdown";
    const total = sheet.cells.length;
    const shown = Math.min(total, Math.max(1, maxRows));
    const truncated = total > shown;
    if (fmt === "json") {
      return { text: JSON.stringify({ sheet: sheet.name, rowCount: sheet.rowCount, colCount: sheet.colCount, rows: sheet.cells.slice(0, shown), merges: sheet.merges, truncated }) };
    }
    const filled = applyMergeFill(sheet.cells, sheet.merges).slice(0, shown);
    if (filled.length === 0) return { text: `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，空表（sheet: ${sheet.name}）` };
    const lines: string[] = [];
    if (fmt === "csv") {
      for (const row of filled) lines.push(row.map(escCsv).join(","));
    } else {
      const header = filled[0];
      lines.push("| " + header.map(escMd).join(" | ") + " |");
      lines.push("| " + header.map(() => "---").join(" | ") + " |");
      for (let i = 1; i < filled.length; i++) lines.push("| " + filled[i].map(escMd).join(" | ") + " |");
    }
    lines.push(truncated
      ? `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，显示 1–${shown} / 共 ${total} 行，提高 maxResults 取更多（sheet: ${sheet.name}）`
      : `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，显示 1–${shown}（sheet: ${sheet.name}）`);
    return { text: lines.join("\n") };
  } catch (e) {
    return { error: "sheet readback error: " + (e instanceof Error ? e.message : String(e)) };
  }
};
```

> **`pattern`（sheet 选择器）在 v1 仅用于校验非空**；跨 worksheet 定位（`_sheetSelector` 真源里预留）留风险项，`sheetProbeFunc` 当前读活动 sheet。若未来接入，把选择器透进 fiber 的 workbook sheet 列表。

- [ ] **Step 4: 加 dispatch case**

在 `packages/extension/src/handlers/query.ts` 的 mode 校验（约 824 行）加入 `sheet`：

```typescript
      if (
        !mode ||
        (mode !== "text" && mode !== "css" && mode !== "component" &&
         mode !== "geometry" && mode !== "style" && mode !== "sheet")
      ) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `vortex_query: mode must be 'text', 'css', 'component', 'geometry', 'style' or 'sheet', got ${String(mode)}`,
        );
      }
```

在 `mode === "style"` 分支之后、`else`（component）之前插入 sheet 分支：

```typescript
      } else if (mode === "sheet") {
        // sheet 模式:注入 sheetProbeFunc 读语雀 Lake Sheet 内存模型 → md/csv/json。
        // pattern = sheet 选择器(v1 仅活动 sheet);attr = 格式;maxResults = 行上限。
        const format = typeof args.attr === "string" ? args.attr : "markdown";
        const maxRows = Math.min((args.maxResults as number | undefined) ?? 200, 1000);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: sheetProbeFunc,
          args: [pattern, format, maxRows],
          world: "MAIN",
        });

        const res = results[0]?.result as { text: string } | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage sheet: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage sheet error: ${res.error}`);
        }
        return res;
      } else if (mode === "style") {
```

> 注意：把新分支插在 `style` 分支**之前**（改 `} else if (mode === "style") {` 为先 `} else if (mode === "sheet") { … } else if (mode === "style") {`），保持既有 style/component 分支不动。

- [ ] **Step 5: 改 MCP schema（mode enum + 描述）**

`packages/mcp/src/tools/schemas-public.ts`：

第 397 行 mode enum 加 `sheet`：
```typescript
        mode: { enum: ["text", "css", "component", "geometry", "style", "sheet"] },
```

第 393 行 description 末尾追加（尽量短，守 I15 ≤8000）：
```typescript
    description: "Zero-LLM probe (no screenshot): text=grep; css=find elems(+attr); component=Vue/React state+row; geometry=bbox/viewport/occlusion/clip+align; style=color/bg/WCAG-contrast; sheet=语雀 Lake Sheet 表格→md/csv/json(attr=格式).",
```

- [ ] **Step 6: 跑 parity + tools/list 预算回归**

Run: `cd packages/extension && pnpm vitest run tests/query-sheet-parity.test.ts`
Expected: PASS（4 例）。

Run: `cd packages/mcp && pnpm vitest run`（含 tools/list ≤8000 断言）
Expected: PASS（tools/list 字节数仍 ≤8000）。若逼近上限，进一步压 description（如 `sheet=Lake Sheet→md/csv/json`）。

- [ ] **Step 7: 构建 + 真站 live 验收（orchestrator，非自动化）**

Run: `cd /Users/lg/workspace/vortex && pnpm build:main`
Expected: 通过；`sheetProbeFunc` 编入 SW bundle。

MCP server 跑 tsx 源码，重启后 `mode=sheet` 端到端可达。live 验收（用户已开 `banniu.yuque.com` 表）：
```
vortex_query({ mode: "sheet", pattern: "*" })
```
Expected：返回 Markdown 表，表头含「订单号 | 评价内容 | 平台评价情感 | …」，footer `> 199 行 × 27 列，显示 1–199（sheet: 历史宝洁反馈评价情感不准案例）`；合并列（如纵向合并的类别列）已 fill-down、无 `|` 破格。再验 `attr:"csv"` 与 `attr:"json"`（json 含 `merges` 精确 span）。

- [ ] **Step 8: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/mcp/src/tools/schemas-public.ts packages/extension/tests/query-sheet-parity.test.ts
git commit -m "feat(query): 加 mode=sheet 语雀 Lake Sheet 结构化 readback(md/csv/json)"
```

---

### Task 4: observe 盲区识别 lake-sheet + 指路渲染

让 observe 把 lake-sheet 识别为专类帧级盲区，渲染 `→ readable via vortex_query mode=sheet`（取代当前误分类的 `list virtual(~2591/17)`）。真源 `detectLakeSheet` + observe.ts 页级扫描内联 parity + observe-render 渲染分支 + 类型扩展。**orchestrator 自留**，真站 live 验收。

**Files:**
- Modify: `packages/extension/src/page-side/blindspot-detect.ts`（加 `detectLakeSheet` + `Blindspot`/frame-blindspot 类型加 `sheet` 变体）
- Modify: `packages/extension/src/handlers/observe.ts`（页级盲区扫描内联 `[inline detectLakeSheet]`）
- Modify: `packages/mcp/src/lib/observe-render.ts:381-395`（`blindspotSummary` frames 循环加 `sheet` 分支）+ `CompactFrame` blindspot 类型加 `sheet`
- Test: `packages/extension/tests/blindspot-detect.test.ts`（`detectLakeSheet` 纯函数，合成内核）
- Test: `packages/extension/tests/observe-blindspot-scan.test.ts`（inline parity 断言）
- Test: `packages/mcp/tests/observe-render-*.test.ts`（渲染分支）

**Interfaces:**
- Consumes: `locateLakeSheetKernel`（Task 2）。
- Produces:
  - `function detectLakeSheet(doc: Document): { rows: number; cols: number } | null` — 定位内核 + 读 `model.data.rowCount/colCount`；非 lake-sheet / 未加载 → null。
  - frame-blindspot 变体 `{ kind: "sheet"; name: string; lib: "lakesheet"; rows: number; cols: number }`。

- [ ] **Step 1: 写失败测试（`detectLakeSheet` 纯函数）**

追加到 `packages/extension/tests/blindspot-detect.test.ts`：

```typescript
import { detectLakeSheet } from "../src/page-side/blindspot-detect.js";

describe("detectLakeSheet", () => {
  it("有 lake-sheet 容器 + 内核 → {rows,cols}", () => {
    // 合成:容器挂 fiber,fiber.memoizedState.sheet.model.data 给维度
    document.body.innerHTML = '<div class="lake-sheet-canvas-container"></div>';
    const el = document.querySelector(".lake-sheet-canvas-container")! as any;
    el["__reactFiber$x"] = {
      memoizedState: { sheet: { model: { data: { rowCount: 199, colCount: 27 }, table: [] } } },
      return: null,
    };
    expect(detectLakeSheet(document)).toEqual({ rows: 199, cols: 27 });
  });
  it("无 lake-sheet 容器 → null", () => {
    document.body.innerHTML = "<div>x</div>";
    expect(detectLakeSheet(document)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/blindspot-detect.test.ts`
Expected: FAIL —「detectLakeSheet is not a function」。

- [ ] **Step 3: 实现 `detectLakeSheet`（真源）**

在 `packages/extension/src/page-side/blindspot-detect.ts` 加（复用 Task 2 的 `locateLakeSheetKernel` 定位逻辑；此处内聚一份轻量定位，仅取维度）：

```typescript
/**
 * 语雀 Lake Sheet 帧级盲区识别:canvas 电子表格,cell 全在 canvas → observe 空树。
 * 定位内核读 model.data 维度,产帧级盲区指向 vortex_query mode=sheet。
 * observe.ts 页级扫描内联同一判定(标记 [inline detectLakeSheet]),改一处须改两处。
 */
export function detectLakeSheet(doc: Document): { rows: number; cols: number } | null {
  const container =
    doc.querySelector(".lake-sheet-canvas-container") || doc.querySelector(".lake-sheet-editor");
  if (!container) return null;
  const fk = Object.keys(container).find(
    (k) => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"),
  );
  if (!fk) return null;
  let fiber: any = (container as any)[fk];
  let depth = 0;
  while (fiber && depth < 40) {
    const st = fiber.memoizedState;
    if (st && st.sheet && st.sheet.model && st.sheet.model.data) {
      const d = st.sheet.model.data;
      const rows = typeof d.rowCount === "number" ? d.rowCount : 0;
      const cols = typeof d.colCount === "number" ? d.colCount : 0;
      return { rows, cols };
    }
    fiber = fiber.return;
    depth++;
  }
  return null;
}
```

在同文件 frame-blindspot 联合类型（`Blindspot` 或 frame `blindspots` 项类型，紧邻 `image`/`canvas`/`virtual` 变体处）加 `sheet` 变体：

```typescript
  | { kind: "sheet"; name: string; lib: "lakesheet"; rows: number; cols: number }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/blindspot-detect.test.ts`
Expected: PASS（含新 2 例）。

- [ ] **Step 5: observe.ts 页级扫描内联 + parity 断言**

在 `packages/extension/src/handlers/observe.ts` 的页级盲区扫描（pageBlindspots pass，紧邻 `[inline detectChartCanvas]`/`[inline detectImageBlindspot]`）加 `[inline detectLakeSheet]`：定位 `.lake-sheet-canvas-container` 内核、取 `model.data.rowCount/colCount`，push 帧级盲区 `{ kind:"sheet", name:"lakesheet", lib:"lakesheet", rows, cols }`（frame 级、每 frame 至多一处）。逐字对齐真源 `detectLakeSheet` 定位逻辑。

追加 parity 断言到 `packages/extension/tests/observe-blindspot-scan.test.ts`：

```typescript
  it("[inline detectLakeSheet] 页级扫描标记 + 定位判据内联(parity)", () => {
    const src = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
    expect(src).toContain("[inline detectLakeSheet]");
    expect(src).toContain(".lake-sheet-canvas-container");
    expect(src).toContain('kind: "sheet"');
  });
```

- [ ] **Step 6: observe-render `sheet` 渲染分支**

`packages/mcp/src/lib/observe-render.ts`：`CompactFrame` 的 `blindspots` 项类型加 `sheet` 变体（同 Task 4 Step 3 的字段）；`blindspotSummary` 的 frames 循环（约 381-395 行）加分支：

```typescript
      if (b.kind === "canvas") {
        parts.push(`${b.name} chart(${b.chartLib}) → read via vortex_evaluate ${chartReadback(b.chartLib).hint}${fr}`);
      } else if (b.kind === "sheet") {
        parts.push(`${b.name} sheet ${b.lib}(${b.rows}×${b.cols}) → readable via vortex_query mode=sheet${fr}`);
      } else if (b.kind === "image") {
```

- [ ] **Step 7: 渲染单测**

追加到 `packages/mcp/tests/observe-render-modal.test.ts`（或新建 observe-render-sheet.test.ts），构造带 `frames:[{blindspots:[{kind:"sheet",name:"lakesheet",lib:"lakesheet",rows:199,cols:27}]}]` 的 CompactObserve，断言渲染含：

```typescript
    expect(out).toContain("lakesheet sheet lakesheet(199×27) → readable via vortex_query mode=sheet");
```

- [ ] **Step 8: 跑全部相关单测**

Run: `cd packages/extension && pnpm vitest run tests/blindspot-detect.test.ts tests/observe-blindspot-scan.test.ts`
Run: `cd packages/mcp && pnpm vitest run`
Expected: 全 PASS。

- [ ] **Step 9: 构建 + 真站 live 验收**

Run: `cd /Users/lg/workspace/vortex && pnpm build:main`；observe-render 走 tsx 源码本 session 生效。
live（`banniu.yuque.com` 表）：`vortex_observe()` 顶部盲区行应出 `# blindspots: … lakesheet sheet lakesheet(199×27) → readable via vortex_query mode=sheet`，不再是误导性的 `list virtual(~2591/17)`。

- [ ] **Step 10: 提交**

```bash
git add packages/extension/src/page-side/blindspot-detect.ts packages/extension/src/handlers/observe.ts packages/mcp/src/lib/observe-render.ts packages/extension/tests/blindspot-detect.test.ts packages/extension/tests/observe-blindspot-scan.test.ts packages/mcp/tests/
git commit -m "feat(observe): 识别语雀 Lake Sheet 盲区并指向 query mode=sheet"
```

---

## 收尾（全 4 任务后）

- [ ] **全量回归**：`cd packages/extension && pnpm vitest run` + `cd packages/mcp && pnpm vitest run`，全绿；tools/list ≤8000。
- [ ] **reflexion 双轮自查**（ship checklist：CHANGELOG 反查 hash / 数字三处一致 / grep 验证 claim / silent fallback 测试）——见 [[ship_checklist_vortex]]。
- [ ] **更新记忆**：新建/更新 `vortex_yuque_lakesheet_readback.md`（mode=sheet ship、fiber 路径、合并混合策略、observe 指路、真站验收结果）。
- [ ] **PR**：`feat/query-sheet-readback` → main，PR 正文含 4 commit + live 验收截图/文本。

## Self-Review（对照 spec）

- **Spec §5 读取机制** → Task 2（locate+read）+ Task 3（内联）✓
- **Spec §6 工具接口**（pattern/attr/maxResults 复用，无新字段）→ Task 3 Step 4/5 ✓
- **Spec §7.1 Markdown 默认 + 行数/总数** → Task 1 serializeSheet + footer ✓
- **Spec §7.2 合并混合策略**（纵向 fill-down / 横向锚点+空）→ Task 1 `applyMergeFill` + 测试 ✓
- **Spec §7.3 转义** → Task 1 `escMd`/`escCsv` + 测试 ✓
- **Spec §7.4 CSV/JSON**（json 保 merge span）→ Task 1 + 测试 ✓
- **Spec §8 observe 闭环** → Task 4 ✓
- **Spec §9 错误兜底**（指向 screenshot）→ Task 3 `sheetProbeFunc` error 分支 ✓
- **Spec §10 只读安全**（不碰 command/history/ot）→ Task 3 probe 注释 + 纯读实现 ✓
- **Spec §12 测试**（纯序列化器单测 + parity + 真站 live）→ Task 1/3/4 ✓
- **类型一致性**：`NormalizedSheet`/`Merge`/`serializeSheet`/`locateLakeSheetKernel`/`readLakeSheetModel`/`detectLakeSheet`/frame-blindspot `sheet` 变体贯穿 Task 1→4 一致 ✓
- **风险项**（跨 worksheet 定位）已在 Task 2/3 显式标注为 v1 仅活动 sheet ✓
