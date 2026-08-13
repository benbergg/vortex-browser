/**
 * Author: qingwa
 * Description: schema 回读真源的 JSON-LD、Microdata 与 OGP 单元测试。
 */

import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { parseJsonLd } from "../src/page-side/schema-readback.js";

/**
 * query mode=schema 真源单测。jsdom 构造真实 document，真实执行解析器，不 mock 内部。
 * 语料取自 2026-08-13 实测：bilibili 视频页(WebPage/VideoObject/BreadcrumbList，含 @id/mainEntity)。
 */
function docOf(html: string): Document {
  return new JSDOM(`<!doctype html><html><head>${html}</head><body></body></html>`).window.document;
}

const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;

describe("parseJsonLd", () => {
  it("单个对象：提取 @type/@id，其余进 props，剔除 @context", () => {
    const doc = docOf(ld(`{"@context":"https://schema.org","@type":"VideoObject","@id":"https://b.tv/1","name":"MV","uploadDate":"2020-01-01"}`));
    const r = parseJsonLd(doc);
    expect(r.scripts).toBe(1);
    expect(r.parseErrors).toBe(0);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0]).toMatchObject({
      type: "VideoObject",
      id: "https://b.tv/1",
      source: "jsonld:0",
      untrusted: true,
    });
    expect(r.entities[0].props).toEqual({ name: "MV", uploadDate: "2020-01-01" });
    expect(r.entities[0].props).not.toHaveProperty("@context");
  });

  it("顶层数组：每个元素一个实体，共享同一 source 下标", () => {
    const doc = docOf(ld(`[{"@type":"WebPage","name":"P"},{"@type":"BreadcrumbList","name":"B"}]`));
    const r = parseJsonLd(doc);
    expect(r.entities.map((e) => e.type)).toEqual(["WebPage", "BreadcrumbList"]);
    expect(r.entities.every((e) => e.source === "jsonld:0")).toBe(true);
  });

  it("@graph 容器：展开成多个实体", () => {
    const doc = docOf(ld(`{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"O"},{"@type":"WebSite","name":"W"}]}`));
    const r = parseJsonLd(doc);
    expect(r.entities.map((e) => e.type)).toEqual(["Organization", "WebSite"]);
  });

  it("@type 为数组：type 取首项，完整数组保留在 props.@type", () => {
    const doc = docOf(ld(`{"@type":["Product","Book"],"name":"N"}`));
    const r = parseJsonLd(doc);
    expect(r.entities[0].type).toBe("Product");
    expect(r.entities[0].props["@type"]).toEqual(["Product", "Book"]);
  });

  it("非法 JSON 只废掉那一段，其余照常返回", () => {
    const doc = docOf(ld(`{"@type":"A","name":"good"}`) + ld(`{not json`) + ld(`{"@type":"C","name":"also good"}`));
    const r = parseJsonLd(doc);
    expect(r.scripts).toBe(3);
    expect(r.parseErrors).toBe(1);
    expect(r.entities.map((e) => e.type)).toEqual(["A", "C"]);
    expect(r.entities.map((e) => e.source)).toEqual(["jsonld:0", "jsonld:2"]);
  });

  it("嵌套对象原样留在 props，不拆成边", () => {
    const doc = docOf(ld(`{"@type":"WebPage","mainEntity":{"@id":"https://b.tv/1","@type":"VideoObject"}}`));
    const r = parseJsonLd(doc);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].props.mainEntity).toEqual({ "@id": "https://b.tv/1", "@type": "VideoObject" });
  });

  it("无 @type 的对象跳过，但不算 parseError", () => {
    const doc = docOf(ld(`{"name":"anonymous"}`));
    const r = parseJsonLd(doc);
    expect(r.entities).toHaveLength(0);
    expect(r.parseErrors).toBe(0);
    expect(r.scripts).toBe(1);
  });

  it("页面无 JSON-LD：全零，不抛", () => {
    const r = parseJsonLd(docOf("<title>x</title>"));
    expect(r).toEqual({ entities: [], scripts: 0, parseErrors: 0 });
  });
});
