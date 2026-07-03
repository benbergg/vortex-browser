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
    expect(src).toContain("m.colCount === 1 && m.rowCount > 1");
    expect(src).toContain('replace(/\\|/g, "\\\\|")');
  });
  it("内联含 cell 取值契约 value ?? ''", () => {
    expect(src).toContain("c.value");
  });
  it("内联含富单元格图片渲染 + 尾部空行列裁剪(与真源一致)", () => {
    expect(src).toContain('v.class === "image"');   // 图片 → markdown 图片
    expect(src).toContain("lastRow = -1, lastCol = -1"); // 尾部裁剪
  });
  it("内联含工作簿页签枚举 + 清单行(与真源一致)", () => {
    expect(src).toContain(".lake-sheet-tab-item");        // 页签枚举
    expect(src).toContain("lake-sheet-tab-item-active");  // 活动标记
    expect(src).toContain("工作簿(");                      // 清单行
  });
});

describe("sheetProbeFunc 钉钉 fallback 内联 ↔ sheet-readback 真源 parity", () => {
  const readback = readFileSync(
    join(__dirname, "../src/page-side/sheet-readback.ts"), "utf8",
  );
  it("query.ts 含 [inline dingtalk-sheet] 标记", () => {
    expect(src).toContain("[inline dingtalk-sheet]");
  });
  it("内联 + 真源均含钉钉检测关键判据(地址框 + 同源 iframe 下钻)", () => {
    for (const s of [src, readback]) {
      expect(s).toContain(".m-formular-bar-inner");      // 地址框
      expect(s).toContain("#wiki-new-sheet-iframe");     // 同源 iframe 下钻
    }
  });
  it("内联 + 真源均含 activeCell A1 地址正则", () => {
    for (const s of [src, readback]) {
      expect(s).toContain("^[A-Z]{1,3}[0-9]{1,7}");
    }
  });
});
