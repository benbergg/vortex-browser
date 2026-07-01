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
