/**
 * Author: qingwa
 * Description: schema 回读真源的 JSON-LD、Microdata 与 OGP 单元测试。
 */

import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  parseJsonLd,
  parseMicrodata,
  parseOpenGraph,
  readPageSchema,
  serializeSchema,
  SCHEMA_MAX_VALUE_CHARS,
} from "../src/page-side/schema-readback.js";

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

function fullDoc(head: string, body: string): Document {
  return new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).window.document;
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

  it("无 itemtype 的 itemscope 跳过（无类型无法判定实体），并计入 untypedItems", () => {
    const doc = bodyOf(`<div itemscope><span itemprop="x">1</span></div>`);
    const r = parseMicrodata(doc);
    expect(r.itemscopes).toBe(1);
    expect(r.entities).toHaveLength(0);
    expect(r.untypedItems).toBe(1);
  });

  // GitHub live 实测:两个 item 都有 itemtype 且成功返回,自陈却仍说"有 item 缺 itemtype 被跳过"。
  // untypedItems 必须是真实计数,否则自陈会编造一个不存在的跳过原因。
  it("item 都带 itemtype 时 untypedItems 为 0", () => {
    const doc = bodyOf(`
      <div itemscope itemtype="A"><span itemprop="n">1</span></div>
      <div itemscope itemtype="B"><span itemprop="n">2</span></div>`);
    const r = parseMicrodata(doc);
    expect(r.entities).toHaveLength(2);
    expect(r.untypedItems).toBe(0);
  });

  it("嵌套 item 缺 itemtype 不算 untypedItems（它是父属性值，不该成顶层实体）", () => {
    const doc = bodyOf(`
      <div itemscope itemtype="Outer">
        <div itemprop="inner" itemscope><span itemprop="a">1</span></div>
      </div>`);
    const r = parseMicrodata(doc);
    expect(r.itemscopes).toBe(2);
    expect(r.untypedItems).toBe(0);
  });

  it("页面无 microdata：全零，不抛", () => {
    expect(parseMicrodata(bodyOf("<p>hi</p>"))).toEqual({ entities: [], itemscopes: 0, itemrefsSkipped: 0, untypedItems: 0 });
  });
});

describe("parseOpenGraph", () => {
  it("规范写法 property=：收成单个实体，键去掉 og: 前缀", () => {
    const doc = docOf(`
      <meta property="og:type" content="video.other">
      <meta property="og:title" content="Never Gonna Give You Up">
      <meta property="og:url" content="https://b.tv/BV1GJ">`);
    const r = parseOpenGraph(doc);
    expect(r.metas).toBe(3);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0]).toMatchObject({ type: "video.other", source: "og", untrusted: true, id: "https://b.tv/BV1GJ" });
    expect(r.entities[0].props).toEqual({ type: "video.other", title: "Never Gonna Give You Up", url: "https://b.tv/BV1GJ" });
  });

  it("非规范写法 name=：一样要收（MDN 实测就是这么写的）", () => {
    const doc = docOf(`<meta name="og:title" content="MDN table"><meta name="og:site_name" content="MDN Web Docs">`);
    const r = parseOpenGraph(doc);
    expect(r.metas).toBe(2);
    expect(r.entities[0].props).toEqual({ title: "MDN table", site_name: "MDN Web Docs" });
  });

  it("无 og:type 时 type 回退为 website", () => {
    const doc = docOf(`<meta property="og:title" content="T">`);
    expect(parseOpenGraph(doc).entities[0].type).toBe("website");
  });

  it("同键重复（og:image 多张）：值收成数组", () => {
    const doc = docOf(`<meta property="og:image" content="a.png"><meta property="og:image" content="b.png">`);
    expect(parseOpenGraph(doc).entities[0].props.image).toEqual(["a.png", "b.png"]);
  });

  it("只有 twitter:/其他 meta：不产实体", () => {
    const doc = docOf(`<meta name="twitter:card" content="summary"><meta name="description" content="d">`);
    expect(parseOpenGraph(doc)).toEqual({ entities: [], metas: 0 });
  });
});

describe("readPageSchema", () => {
  it("三源合并：顺序 jsonld → microdata → og，scanned 如实计数", () => {
    const doc = fullDoc(
      ld(`{"@type":"WebPage","name":"W"}`) + `<meta property="og:title" content="T">`,
      `<div itemscope itemtype="Product"><span itemprop="name">P</span></div>`,
    );
    const r = readPageSchema(doc, null, 20);
    expect(r.entities.map((e) => e.source)).toEqual(["jsonld:0", "microdata:0", "og"]);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.scanned).toEqual({ ldScripts: 1, ldParseErrors: 0, itemscopes: 1, itemrefsSkipped: 0, untypedItems: 0, ogMetas: 1, iframes: 0 });
  });

  it("iframes 计数在 page-side 一并采集（SW 侧看不到页面 DOM，事后补不回来）", () => {
    const doc = fullDoc("", `<iframe src="a.html"></iframe><iframe src="b.html"></iframe>`);
    expect(readPageSchema(doc, null, 20).scanned.iframes).toBe(2);
  });

  it("typeFilter 大小写不敏感、按后缀匹配完整 IRI", () => {
    const doc = fullDoc(
      ld(`[{"@type":"https://schema.org/Product","name":"A"},{"@type":"BreadcrumbList","name":"B"}]`),
      "",
    );
    expect(readPageSchema(doc, "product", 20).entities.map((e) => e.props.name)).toEqual(["A"]);
  });

  it("typeFilter='*' 等同不过滤", () => {
    const doc = fullDoc(ld(`[{"@type":"A","name":"1"},{"@type":"B","name":"2"}]`), "");
    expect(readPageSchema(doc, "*", 20).total).toBe(2);
  });

  it("超 maxEntities 截断：entities 被裁，total 报裁前总数，truncated=true", () => {
    const doc = fullDoc(ld(`[{"@type":"A"},{"@type":"A"},{"@type":"A"}]`), "");
    const r = readPageSchema(doc, null, 2);
    expect(r.entities).toHaveLength(2);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it("超长字符串值被截断并加省略标记", () => {
    const long = "x".repeat(SCHEMA_MAX_VALUE_CHARS + 50);
    const doc = fullDoc(ld(`{"@type":"A","description":${JSON.stringify(long)}}`), "");
    const v = readPageSchema(doc, null, 20).entities[0].props.description as string;
    expect(v.length).toBe(SCHEMA_MAX_VALUE_CHARS + 1);
    expect(v.endsWith("…")).toBe(true);
  });

  it("过滤后为空但页面确有数据：total=0 而 scanned 非零", () => {
    const doc = fullDoc(ld(`{"@type":"A","name":"n"}`), "");
    const r = readPageSchema(doc, "NoSuchType", 20);
    expect(r.total).toBe(0);
    expect(r.scanned.ldScripts).toBe(1);
  });
});

describe("serializeSchema", () => {
  it("json 格式返回可解析的完整载荷", () => {
    const doc = fullDoc(ld(`{"@type":"A","name":"n"}`), "");
    const parsed = JSON.parse(serializeSchema(readPageSchema(doc, null, 20), "json"));
    expect(parsed.entities[0].untrusted).toBe(true);
    expect(parsed.total).toBe(1);
  });

  it("summary 格式含来源与 untrusted 提示", () => {
    const doc = fullDoc(ld(`{"@type":"Product","name":"P"}`), "");
    const text = serializeSchema(readPageSchema(doc, null, 20), "summary");
    expect(text).toContain("检测到 1 个实体");
    expect(text).toContain("Product");
    expect(text).toContain("jsonld:0");
    expect(text).toContain("页面作者声明");
  });

  it("summary 在截断时标出被裁数量", () => {
    const doc = fullDoc(ld(`[{"@type":"A"},{"@type":"A"},{"@type":"A"}]`), "");
    expect(serializeSchema(readPageSchema(doc, null, 2), "summary")).toContain("已截断");
  });
});
