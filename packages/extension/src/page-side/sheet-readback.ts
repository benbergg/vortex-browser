/**
 * 语雀 Lake Sheet 结构化 readback 真源(纯逻辑)。
 * NormalizedSheet 是从 LakeSheet 内存模型归一化后的中间形态(见 Task 2 readLakeSheetModel):
 * cells = 锚点+空的原始网格(合并被覆盖格为 ""),merges = 精确 span 列表。
 * serializeSheet 施加合并混合策略 + 转义 + 行截断 + 格式分派。
 * ⚠ page-side probe(query.ts sheetProbeFunc)内联同一逻辑(注入丢模块作用域),
 * 改一处须改两处;query-sheet-parity.test.ts 校验。
 */
export interface Merge { row: number; col: number; rowCount: number; colCount: number; }
export interface Worksheet { name: string; active: boolean; }
export interface NormalizedSheet {
  name: string;
  rowCount: number;
  colCount: number;
  cells: string[][];
  merges: Merge[];
  /** 同工作簿内其他 sheet 页签(供模型发现+切换),仅 probe 从 DOM 填。 */
  worksheets?: Worksheet[];
}
export type SheetFormat = "markdown" | "csv" | "json";

/**
 * 从底部页签栏枚举工作簿(2026-07-01 语雀实测:`.lake-sheet-tab-item` 各页签,名在
 * `.sheet-name-container`,活动页 `.lake-sheet-tab-item-active`)。让模型知道有哪些 sheet。
 * ⚠ probe 内联同一逻辑,改一处须改两处;query-sheet-parity.test.ts 校验。
 */
export function readWorksheetTabs(doc: Document): Worksheet[] {
  const tabs = Array.from(doc.querySelectorAll(".lake-sheet-tab-item"));
  const out: Worksheet[] = [];
  for (const t of tabs) {
    const nameEl = t.querySelector(".sheet-name-container");
    const name = ((nameEl && nameEl.textContent) || t.textContent || "").trim();
    if (name) out.push({ name, active: t.classList.contains("lake-sheet-tab-item-active") });
  }
  return out;
}

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
      worksheets: sheet.worksheets,
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
  // 工作簿清单(>1 sheet):让模型知道有哪些 sheet 及怎么切换。仅活动 sheet 有数据,其余标名。
  if (sheet.worksheets && sheet.worksheets.length > 1) {
    const names = sheet.worksheets.map((w) => (w.active ? `*${w.name}` : w.name)).join(" | ");
    lines.push(`> 工作簿(${sheet.worksheets.length}): ${names} — 切换其他 sheet: vortex_act 点对应页签(见 observe)后再 vortex_query mode=sheet`);
  }
  return lines.join("\n");
}

/**
 * 钉钉 spreadsheetv2(flex_table_app)是纯 canvas 电子表格,无 DOM 单元格、无 per-cell ref,
 * 与语雀 Lake Sheet 的 React fiber 模型完全不同。表格常渲染在同源 iframe #wiki-new-sheet-iframe
 * 内,或 probe 已注入该 iframe → doc 本身含地址框 .m-formular-bar-inner。
 *
 * ⚠ 范围(2026-07 dogfood 实测):仅 **检测 + activeCell**(地址框读回)。单元格网格读回需读
 * collab-engine/mobx workbook 模型,尚未 live 验证 → 不臆造,故 readDingtalkSheet 只回 detected
 * +activeCell,让上层给出"用 vortex_screenshot / vortex_mouse_click 按像素定位"的诚实指引。
 * ⚠ probe 内联同一逻辑,改一处须改两处;query-sheet-parity.test.ts 校验。
 */
export interface DingtalkSheetInfo { detected: boolean; activeCell: string | null; }

/** 解析钉钉表格所在 document:本 doc 直含地址框则用之;否则下钻同源 #wiki-new-sheet-iframe。 */
export function resolveDingtalkSheetDoc(doc: Document): Document | null {
  if (doc.querySelector(".m-formular-bar-inner")) return doc;
  const fr = doc.querySelector("#wiki-new-sheet-iframe") as HTMLIFrameElement | null;
  try {
    const idoc = fr && fr.contentDocument;
    if (idoc && idoc.querySelector(".m-formular-bar-inner")) return idoc;
  } catch { /* cross-origin iframe:无法读,视作未检测到 */ }
  return null;
}

/** 从地址框 .m-formular-bar-inner 读活动单元格 A1 地址(叶子节点文本匹配 ^[A-Z]+[0-9]+)。 */
export function readDingtalkActiveCell(sheetDoc: Document): string | null {
  const bar = sheetDoc.querySelector(".m-formular-bar-inner");
  if (!bar) return null;
  for (const el of Array.from(bar.querySelectorAll("*"))) {
    if (el.children.length === 0) {
      const t = ((el.textContent as string) || "").trim();
      if (/^[A-Z]{1,3}[0-9]{1,7}$/.test(t)) return t;
    }
  }
  return null;
}

/** 检测钉钉 canvas 电子表格并读 activeCell。非钉钉表格页返回 null(交回语雀分支/报错)。 */
export function readDingtalkSheet(doc: Document): DingtalkSheetInfo | null {
  const sheetDoc = resolveDingtalkSheetDoc(doc);
  if (!sheetDoc) return null;
  return { detected: true, activeCell: readDingtalkActiveCell(sheetDoc) };
}

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
    if (v == null) return "";
    if (typeof v === "object") {
      // 富单元格:语雀内联图片 {class:"image",src,name} → markdown 图片(保 name+src);
      // 其他对象取 .text,再退回 JSON 片段——绝不吐 [object Object](误导 + 丢信息)。
      if (v.class === "image" && typeof v.src === "string") return `![${v.name || "image"}](${v.src})`;
      if (typeof v.text === "string") return v.text;
      try { return JSON.stringify(v).slice(0, 100); } catch { return ""; }
    }
    return String(v);
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
  // 去尾部全空行/列:语雀分配的 rowCount/colCount 常远大于真实内容(实测 199×27 仅 39×11 有值),
  // 返回全量会吐大量空行空列(token 浪费 + "199 行"误导)。仅裁尾部,保留内部空行(可能是分节)。
  let lastRow = -1, lastCol = -1;
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < colCount; c++) {
      if (cells[r][c] !== "") { if (r > lastRow) lastRow = r; if (c > lastCol) lastCol = c; }
    }
  }
  const nRows = lastRow + 1, nCols = lastCol + 1;
  const trimmedCells = cells.slice(0, nRows).map((row) => row.slice(0, nCols));
  const trimmedMerges = merges.filter((mg) => mg.row < nRows && mg.col < nCols);
  return {
    name: typeof d.name === "string" ? d.name : "",
    rowCount: nRows,
    colCount: nCols,
    cells: trimmedCells,
    merges: trimmedMerges,
  };
}
