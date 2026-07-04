import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/handlers/query.ts"), "utf8");
const trueSrc = readFileSync(join(__dirname, "../src/page-side/chart-readback.ts"), "utf8");

/**
 * chartProbeFunc(query.ts 内联,注入 MAIN world)必须与 chart-readback.ts 真源逻辑一致。
 * 内联丢模块作用域不可 import,故 source-grep 守护关键判据 parity;真实行为由
 * chart-readback.test.ts(真源单测)+ live 验证。镜像 query-flow-parity。
 */
describe("chartProbeFunc 内联 ↔ chart-readback 真源 parity", () => {
  it("query.ts 含 [inline chart-readback] 标记", () => {
    expect(src).toContain("[inline chart-readback]");
  });
  it("内联含 echarts detect 判据(与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain('querySelector("[_echarts_instance_]")');
      expect(s).toContain("getInstanceByDom");
      expect(s).toContain("getInstanceById"); // fallback
    }
  });
  it("内联含 getOption 归一化(series 截断 + chartType 取首系列,与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain("getOption");
      expect(s).toContain("data.slice(0,"); // 系列截断(真源 maxPoints/内联 maxP)
      expect(s).toContain("cs.truncated = data.length");
      expect(s).toContain('chartType: series[0]?.type ?? "unknown"');
    }
  });
  it("内联含 summary/json 序列化(与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain("结构数据:");            // summary 内嵌结构数据
      expect(s).toContain('JSON.stringify({ charts })'); // json
      expect(s).toContain("检测到 ");              // 摘要头
    }
  });
  it("无图表优雅降级(与 flow 一致的 error 契约)", () => {
    expect(src).toContain("no chart on page");
  });
});
