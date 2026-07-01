import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/handlers/query.ts"), "utf8");

describe("flowProbeFunc 内联 ↔ flow-readback 真源 parity", () => {
  it("query.ts 含 [inline flow-readback] 标记", () => {
    expect(src).toContain("[inline flow-readback]");
  });
  it("内联含 ipaas detect + Vue 模型读判据(与真源一致)", () => {
    expect(src).toContain(".processSetting-body");
    expect(src).toContain("_data && Array.isArray(cur.__vue__._data.nodesDataList)");
  });
  it("内联含 mermaid 渲染 + branchData 递归(与真源一致)", () => {
    expect(src).toContain("flowchart TD");
    expect(src).toContain("branchData"); // 并行递归
    expect(src).toContain('#quot;');      // mermaid `"` 转义
  });
});
