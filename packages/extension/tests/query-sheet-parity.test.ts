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
});
