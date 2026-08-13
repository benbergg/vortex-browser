/**
 * Author: qingwa
 * Description: schema 回读真源的 JSON-LD、Microdata 与 OGP 单元测试。
 */

import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { parseJsonLd, parseMicrodata } from "../src/page-side/schema-readback.js";

/**
 * query mode=schema 真源单测。jsdom 构造真实 document，真实执行解析器，不 mock 内部。
 * 语料取自 2026-08-13 实测：bilibili 视频页(WebPage/VideoObject/BreadcrumbList，含 @id/mainEntity)。
 */
function docOf(html: string): Document {
  return new JSDOM(`<!doctype html><html><head>${html}</head><body></body></html>`).window.document;
}

function bodyOf(html: string): Document {
  return new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`).window.document;
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

describe("parseMicrodata", () => {
  it("扁平 item：itemtype→type，itemprop→props，itemid→id", () => {
    const doc = bodyOf(`
      <div itemscope itemtype="https://schema.org/SoftwareSourceCode" itemid="urn:repo:1">
        <span itemprop="name">anthropic-sdk-typescript</span>
        <span itemprop="programmingLanguage">TypeScript</span>
      </div>`);
    const r = parseMicrodata(doc);
    expect(r.itemscopes).toBe(1);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0]).toMatchObject({
      type: "https://schema.org/SoftwareSourceCode",
      id: "urn:repo:1",
      source: "microdata:0",
      untrusted: true,
    });
    expect(r.entities[0].props).toEqual({ name: "anthropic-sdk-typescript", programmingLanguage: "TypeScript" });
  });

  it("按标签取值：meta→content, a→href, img→src, time→datetime", () => {
    const doc = bodyOf(`
      <div itemscope itemtype="T">
        <meta itemprop="ratingValue" content="4.5">
        <a itemprop="url" href="https://e.test/p">link text</a>
        <img itemprop="image" src="https://e.test/i.png">
        <time itemprop="datePublished" datetime="2026-08-13">昨天</time>
      </div>`);
    const props = parseMicrodata(doc).entities[0].props;
    expect(props).toEqual({
      ratingValue: "4.5",
      url: "https://e.test/p",
      image: "https://e.test/i.png",
      datePublished: "2026-08-13",
    });
  });

  it("嵌套 item 作为父属性的值，不单列为顶层实体", () => {
    const doc = bodyOf(`
      <div itemscope itemtype="Product">
        <span itemprop="name">P</span>
        <div itemprop="offers" itemscope itemtype="Offer"><span itemprop="price">9.9</span></div>
      </div>`);
    const r = parseMicrodata(doc);
    expect(r.itemscopes).toBe(2);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].props.offers).toEqual({ "@type": "Offer", price: "9.9" });
  });

  it("itemprop 归属最近的 itemscope 祖先，不串到外层", () => {
    const doc = bodyOf(`
      <div itemscope itemtype="Outer">
        <span itemprop="a">outerA</span>
        <div itemprop="inner" itemscope itemtype="Inner"><span itemprop="a">innerA</span></div>
      </div>`);
    const e = parseMicrodata(doc).entities[0];
    expect(e.props.a).toBe("outerA");
    expect(e.props.inner).toEqual({ "@type": "Inner", a: "innerA" });
  });

  it("一个 itemprop 写多个名字：每个名字各拿一份值", () => {
    const doc = bodyOf(`<div itemscope itemtype="T"><span itemprop="name headline">X</span></div>`);
    expect(parseMicrodata(doc).entities[0].props).toEqual({ name: "X", headline: "X" });
  });

  it("同名 itemprop 出现多次：值收成数组", () => {
    const doc = bodyOf(`<div itemscope itemtype="T"><span itemprop="tag">a</span><span itemprop="tag">b</span></div>`);
    expect(parseMicrodata(doc).entities[0].props.tag).toEqual(["a", "b"]);
  });

  it("itemref 只计数不解析，且不影响其余属性", () => {
    const doc = bodyOf(`
      <div itemscope itemtype="T" itemref="ext"><span itemprop="name">N</span></div>
      <span id="ext" itemprop="extra">E</span>`);
    const r = parseMicrodata(doc);
    expect(r.itemrefsSkipped).toBe(1);
    expect(r.entities[0].props).toEqual({ name: "N" });
  });

  it("无 itemtype 的 itemscope 跳过（无类型无法判定实体）", () => {
    const doc = bodyOf(`<div itemscope><span itemprop="x">1</span></div>`);
    const r = parseMicrodata(doc);
    expect(r.itemscopes).toBe(1);
    expect(r.entities).toHaveLength(0);
  });

  it("页面无 microdata：全零，不抛", () => {
    expect(parseMicrodata(bodyOf("<p>hi</p>"))).toEqual({ entities: [], itemscopes: 0, itemrefsSkipped: 0 });
  });
});
