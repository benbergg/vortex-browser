/**
 * Author: qingwa
 * Description: schemaProbeFunc 内联副本与 page-side 真源的同步守卫。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/handlers/query.ts"), "utf8");
const trueSrc = readFileSync(join(__dirname, "../src/page-side/schema-readback.ts"), "utf8");

/**
 * schemaProbeFunc(query.ts 内联,注入 MAIN world)必须与 schema-readback.ts 真源逻辑一致。
 * 内联丢模块作用域不可 import,故 source-grep 守护关键判据 parity;真实行为由
 * schema-readback.test.ts(真源单测)+ bench case 验证。镜像 query-chart-parity。
 */
describe("schemaProbeFunc 内联 ↔ schema-readback 真源 parity", () => {
  it("query.ts 含 [inline schema-readback] 标记", () => {
    expect(src).toContain("[inline schema-readback]");
  });
  it("内联含三源选择器(与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain('script[type="application/ld+json"]');
      expect(s).toContain('querySelectorAll("[itemscope]")');
      expect(s).toContain('startsWith("og:")');
    }
  });
  it("内联含 OGP 双属性回退(property 缺失时取 name)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain('getAttribute("property") || m.getAttribute("name")');
    }
  });
  it("内联含 @graph 展开与非法段隔离(与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain('obj["@graph"]');
      expect(s).toContain("parseErrors++");
    }
  });
  it("内联含 itemref 跳过计数与嵌套 item 归属判定(与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain("itemrefsSkipped");
      expect(s).toContain('closest("[itemscope]")');
    }
  });
  // 自陈按真实计数说话:两边都必须真的累加,否则内联那侧会退回无条件断言
  it("内联含 untypedItems 真实累加(与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain("untypedItems++");
    }
  });
  it("内联含预算截断与 untrusted 恒真(与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain("SCHEMA_MAX_VALUE_CHARS");
      expect(s).toContain("untrusted: true");
    }
  });
  it("内联在 page-side 采 iframe 数(SW 侧补不回来,与真源一致)", () => {
    for (const s of [src, trueSrc]) {
      expect(s).toContain('querySelectorAll("iframe").length');
    }
  });
});
