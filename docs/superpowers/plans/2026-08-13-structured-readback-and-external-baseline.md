# 结构化回读 + 外部基线对照 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `vortex_query` 加 `mode=schema`，一次调用把页面作者声明的结构化数据（JSON-LD / Microdata / OGP）读成带来源的实体列表；并建立与 `chrome-devtools-mcp` 的外部对照基线，破掉自家 bench 自证的闭环。

**Architecture:** 沿用仓库既有的 page-side 双源范式——真源 `packages/extension/src/page-side/schema-readback.ts`（可 import、jsdom 真测），`query.ts` 内联一份自包含副本供 `executeScript({func})` 注入（注入丢模块作用域，不能 import），再用 source-grep parity 测试锁两者一致。输出走扁平 `entities[]`，不建 edges 图、不引 RDF store。空结果复用 `withDiagnosis` 自陈信道。

**Tech Stack:** TypeScript / vitest + jsdom / Chrome MV3 `chrome.scripting.executeScript` / MCP stdio

## Global Constraints

- **跑测试必须限并发**：`vitest run --maxWorkers=2 --minWorkers=1`。禁止默认满核，禁止在仓库根跑 `pnpm -r test`。
- **page-side 内联 func 必须完全自包含**：`executeScript({func})` 注入时丢模块作用域，任何外部引用都会在页面里变成 `X is not defined`。内联副本内不得出现 import 或外部常量引用。
- **真源单测不得只做 source-grep**：source-grep parity 只是内联副本的同步守卫，真实行为断言必须打在 `page-side/schema-readback.ts` 的导出纯函数上（jsdom 真实执行）。
- **OGP 必须同时接受 `property` 和 `name` 两个属性**：实测 MDN 用 `<meta name="og:url">`，只按 OGP 规范写选择器会静默返回空。
- **注释规范**：中文；方法体内一律单行 `//`，每条 ≤1 行 ≤60 字，同一方法体内 ≤3 条；只写「为什么」不复述代码。
- **提交规范**：Conventional Commits，`<type>: <中文描述>`，结尾无句号；禁止 `Co-Authored-By` 等署名。
- **`tools/list` 预算 4500 字节**：改 `schemas-public.ts` 的 description 要算字节，能省则省。
- **构建**：改完 page-side 必须跑完整 `pnpm --filter @vortex-browser/extension build`（`build:main` 单跑会清掉 `dist/page-side`）。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/extension/src/page-side/schema-readback.ts`（新建） | 真源。JSON-LD / Microdata / OGP 三个独立解析器 + 合并/截断入口 + 序列化 |
| `packages/extension/tests/schema-readback.test.ts`（新建） | 真源 jsdom 单测 |
| `packages/extension/src/lib/empty-diagnosis.ts`（改） | 加 `SchemaEmptyFacts` 与 `diagnoseEmptySchema` |
| `packages/extension/tests/query-empty-diagnosis.test.ts`（改） | 加 schema 空自陈断言 |
| `packages/extension/src/handlers/query.ts`（改） | 内联 `schemaProbeFunc`；mode 白名单加 `schema`；新增 handler 分支 |
| `packages/extension/tests/query-schema-parity.test.ts`（新建） | 内联 ↔ 真源 source-grep parity |
| `packages/mcp/src/tools/schemas-public.ts`（改，`:454`） | mode enum 加 `schema` |
| `packages/vortex-bench/playground/public/synth/schema-readback.html`（新建） | 三源齐全的静态 fixture |
| `packages/vortex-bench/cases/query-schema.case.ts`（新建） | bench case |
| `packages/vortex-bench/src/runner/external-baseline.ts`（新建） | 对照 runner，复用 `mcp-client.ts` |
| `reports/external-baseline-2026-08/`（新建） | 对照报告 + WebMCP/APC 探测记录 |

---

## Task 1: JSON-LD 解析器

**Files:**
- Create: `packages/extension/src/page-side/schema-readback.ts`
- Test: `packages/extension/tests/schema-readback.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface SchemaEntity { type: string; props: Record<string, unknown>; source: string; untrusted: true; id?: string }`
  - `interface JsonLdResult { entities: SchemaEntity[]; scripts: number; parseErrors: number }`
  - `function parseJsonLd(doc: Document): JsonLdResult`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/schema-readback.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `Failed to resolve import "../src/page-side/schema-readback.js"`

- [ ] **Step 3: 实现最小代码**

创建 `packages/extension/src/page-side/schema-readback.ts`：

```ts
// page-side 结构化数据回读真源：JSON-LD / Microdata / OGP。
//
// 这三种都是**页面作者的声明**，WHATWG 明确 microdata item 与视觉内容无自动关系，
// Google 也明确 structured data 不保证与可见内容一致 —— 故所有实体恒带 untrusted。
//
// query.ts 内有一份自包含内联副本供 executeScript({func}) 注入（注入丢模块作用域，
// 不能 import）。改动本文件必须同步内联副本，parity 由 query-schema-parity.test.ts 守。
// [inline schema-readback]

export interface SchemaEntity {
  /** @type / itemtype / og:type；数组取首项 */
  type: string;
  props: Record<string, unknown>;
  /** jsonld:<scriptIdx> | microdata:<itemIdx> | og */
  source: string;
  untrusted: true;
  /** @id / itemid */
  id?: string;
}

export interface JsonLdResult {
  entities: SchemaEntity[];
  scripts: number;
  parseErrors: number;
}

const LD_SELECTOR = 'script[type="application/ld+json"]';

function firstType(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === "string" && t.trim()) return t.trim();
  }
  return null;
}

function toEntity(obj: Record<string, unknown>, source: string): SchemaEntity | null {
  const type = firstType(obj["@type"]);
  if (!type) return null;
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "@context" || k === "@id") continue;
    props[k] = v;
  }
  // @type 是数组时首项已提到 type，完整数组仍留 props 供调用方看全
  if (!Array.isArray(obj["@type"])) delete props["@type"];
  const e: SchemaEntity = { type, props, source, untrusted: true };
  const id = obj["@id"];
  if (typeof id === "string" && id) e.id = id;
  return e;
}

/** 把一段 JSON-LD 顶层值摊平成对象数组（支持数组与 @graph 容器）。 */
function flattenLd(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) {
    return (obj["@graph"] as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
  }
  return [obj];
}

export function parseJsonLd(doc: Document): JsonLdResult {
  const scripts = Array.from(doc.querySelectorAll(LD_SELECTOR));
  const entities: SchemaEntity[] = [];
  let parseErrors = 0;
  scripts.forEach((s, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.textContent || "");
    } catch {
      parseErrors++;
      return;
    }
    for (const obj of flattenLd(parsed)) {
      const e = toEntity(obj, `jsonld:${i}`);
      if (e) entities.push(e);
    }
  });
  return { entities, scripts: scripts.length, parseErrors };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/schema-readback.ts packages/extension/tests/schema-readback.test.ts
git commit -m "feat: page-side JSON-LD 回读真源"
```

---

## Task 2: Microdata 解析器

**Files:**
- Modify: `packages/extension/src/page-side/schema-readback.ts`
- Test: `packages/extension/tests/schema-readback.test.ts`

**Interfaces:**
- Consumes: `SchemaEntity`（Task 1）
- Produces:
  - `interface MicrodataResult { entities: SchemaEntity[]; itemscopes: number; itemrefsSkipped: number }`
  - `function parseMicrodata(doc: Document): MicrodataResult`

- [ ] **Step 1: 写失败测试**

追加到 `packages/extension/tests/schema-readback.test.ts`：

```ts
import { parseMicrodata } from "../src/page-side/schema-readback.js";

function bodyOf(html: string): Document {
  return new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`).window.document;
}

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `parseMicrodata is not a function`

- [ ] **Step 3: 实现最小代码**

追加到 `packages/extension/src/page-side/schema-readback.ts`：

```ts
export interface MicrodataResult {
  entities: SchemaEntity[];
  itemscopes: number;
  /** 含 itemref 的 item 数。v1 不解析跨节点引用，只如实报数 */
  itemrefsSkipped: number;
}

const SRC_TAGS = new Set(["IMG", "AUDIO", "EMBED", "IFRAME", "SOURCE", "TRACK", "VIDEO"]);
const HREF_TAGS = new Set(["A", "AREA", "LINK"]);

function itemValue(el: Element): unknown {
  if (el.hasAttribute("itemscope")) return readItem(el);
  const tag = el.tagName;
  if (tag === "META") return el.getAttribute("content") || "";
  if (HREF_TAGS.has(tag)) return el.getAttribute("href") || "";
  if (SRC_TAGS.has(tag)) return el.getAttribute("src") || "";
  if (tag === "OBJECT") return el.getAttribute("data") || "";
  if (tag === "DATA" || tag === "METER") return el.getAttribute("value") || "";
  if (tag === "TIME") return el.getAttribute("datetime") || (el.textContent || "").trim();
  return (el.textContent || "").trim();
}

/** itemprop 元素归属最近的 itemscope 祖先；自身是嵌套 item 时要跳过自己再上溯。 */
function ownerOf(el: Element): Element | null {
  const start = el.hasAttribute("itemscope") ? el.parentElement : el;
  return start ? start.closest("[itemscope]") : null;
}

function readItem(scope: Element): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = scope.getAttribute("itemtype");
  if (type) out["@type"] = type;
  for (const el of Array.from(scope.querySelectorAll("[itemprop]"))) {
    if (ownerOf(el) !== scope) continue;
    const value = itemValue(el);
    for (const name of (el.getAttribute("itemprop") || "").split(/\s+/).filter(Boolean)) {
      const prev = out[name];
      if (prev === undefined) out[name] = value;
      else if (Array.isArray(prev)) prev.push(value);
      else out[name] = [prev, value];
    }
  }
  return out;
}

export function parseMicrodata(doc: Document): MicrodataResult {
  const all = Array.from(doc.querySelectorAll("[itemscope]"));
  const entities: SchemaEntity[] = [];
  let itemrefsSkipped = 0;
  let idx = 0;
  for (const scope of all) {
    if (scope.hasAttribute("itemref")) itemrefsSkipped++;
    // 带 itemprop 的 itemscope 是父 item 的属性值，由 readItem 递归取，不做顶层实体
    if (scope.hasAttribute("itemprop")) continue;
    const type = scope.getAttribute("itemtype");
    if (!type) continue;
    const { "@type": _t, ...props } = readItem(scope);
    const e: SchemaEntity = { type, props, source: `microdata:${idx++}`, untrusted: true };
    const itemid = scope.getAttribute("itemid");
    if (itemid) e.id = itemid;
    entities.push(e);
  }
  return { entities, itemscopes: all.length, itemrefsSkipped };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS，17 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/schema-readback.ts packages/extension/tests/schema-readback.test.ts
git commit -m "feat: page-side Microdata 回读，itemref 如实报跳过"
```

---

## Task 3: Open Graph 解析器

**Files:**
- Modify: `packages/extension/src/page-side/schema-readback.ts`
- Test: `packages/extension/tests/schema-readback.test.ts`

**Interfaces:**
- Consumes: `SchemaEntity`（Task 1）
- Produces:
  - `interface OpenGraphResult { entities: SchemaEntity[]; metas: number }`
  - `function parseOpenGraph(doc: Document): OpenGraphResult`

- [ ] **Step 1: 写失败测试**

追加到 `packages/extension/tests/schema-readback.test.ts`：

```ts
import { parseOpenGraph } from "../src/page-side/schema-readback.js";

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `parseOpenGraph is not a function`

- [ ] **Step 3: 实现最小代码**

追加到 `packages/extension/src/page-side/schema-readback.ts`：

```ts
export interface OpenGraphResult {
  entities: SchemaEntity[];
  metas: number;
}

export function parseOpenGraph(doc: Document): OpenGraphResult {
  const props: Record<string, unknown> = {};
  let metas = 0;
  for (const m of Array.from(doc.querySelectorAll("meta"))) {
    // OGP 规范要求 property=，但 MDN 等站实际用 name=，两个都收否则静默空
    const key = m.getAttribute("property") || m.getAttribute("name") || "";
    if (!key.startsWith("og:")) continue;
    metas++;
    const name = key.slice(3);
    if (!name) continue;
    const value = m.getAttribute("content") || "";
    const prev = props[name];
    if (prev === undefined) props[name] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else props[name] = [prev, value];
  }
  if (metas === 0) return { entities: [], metas: 0 };
  const type = typeof props.type === "string" && props.type ? props.type : "website";
  const e: SchemaEntity = { type, props, source: "og", untrusted: true };
  if (typeof props.url === "string" && props.url) e.id = props.url;
  return { entities: [e], metas };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS，22 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/schema-readback.ts packages/extension/tests/schema-readback.test.ts
git commit -m "feat: page-side OGP 回读，property 与 name 双属性都收"
```

---

## Task 4: 合并入口、类型过滤、预算截断与序列化

**Files:**
- Modify: `packages/extension/src/page-side/schema-readback.ts`
- Test: `packages/extension/tests/schema-readback.test.ts`

**Interfaces:**
- Consumes: `parseJsonLd` / `parseMicrodata` / `parseOpenGraph`（Task 1-3）
- Produces:
  - `type SchemaFormat = "summary" | "json"`
  - `const SCHEMA_MAX_ENTITIES = 20`、`const SCHEMA_MAX_VALUE_CHARS = 500`
  - `interface SchemaScanFacts { ldScripts: number; ldParseErrors: number; itemscopes: number; itemrefsSkipped: number; ogMetas: number; iframes: number }`
  - `interface SchemaReadResult { entities: SchemaEntity[]; total: number; truncated: boolean; scanned: SchemaScanFacts }`
  - `function readPageSchema(doc: Document, typeFilter: string | null, maxEntities: number): SchemaReadResult`
  - `function serializeSchema(r: SchemaReadResult, format: SchemaFormat): string`

- [ ] **Step 1: 写失败测试**

追加到 `packages/extension/tests/schema-readback.test.ts`：

```ts
import {
  readPageSchema,
  serializeSchema,
  SCHEMA_MAX_VALUE_CHARS,
} from "../src/page-side/schema-readback.js";

function fullDoc(head: string, body: string): Document {
  return new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).window.document;
}

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
    expect(r.scanned).toEqual({ ldScripts: 1, ldParseErrors: 0, itemscopes: 1, itemrefsSkipped: 0, ogMetas: 1, iframes: 0 });
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `readPageSchema is not a function`

- [ ] **Step 3: 实现最小代码**

追加到 `packages/extension/src/page-side/schema-readback.ts`：

```ts
export type SchemaFormat = "summary" | "json";

export const SCHEMA_MAX_ENTITIES = 20;
export const SCHEMA_MAX_VALUE_CHARS = 500;

export interface SchemaScanFacts {
  ldScripts: number;
  ldParseErrors: number;
  itemscopes: number;
  itemrefsSkipped: number;
  ogMetas: number;
  /** 同页 iframe 数。只能在 page-side 采，SW 侧拿不到页面 DOM */
  iframes: number;
}

export interface SchemaReadResult {
  entities: SchemaEntity[];
  /** 过滤后、截断前的总数 */
  total: number;
  truncated: boolean;
  scanned: SchemaScanFacts;
}

function typeMatches(type: string, filter: string): boolean {
  const t = type.toLowerCase();
  const f = filter.toLowerCase();
  return t === f || t.endsWith(`/${f}`) || t.endsWith(`#${f}`);
}

function clampValue(v: unknown): unknown {
  if (typeof v === "string" && v.length > SCHEMA_MAX_VALUE_CHARS) return v.slice(0, SCHEMA_MAX_VALUE_CHARS) + "…";
  if (Array.isArray(v)) return v.map(clampValue);
  return v;
}

export function readPageSchema(
  doc: Document,
  typeFilter: string | null,
  maxEntities: number,
): SchemaReadResult {
  const ld = parseJsonLd(doc);
  const md = parseMicrodata(doc);
  const og = parseOpenGraph(doc);
  const scanned: SchemaScanFacts = {
    ldScripts: ld.scripts,
    ldParseErrors: ld.parseErrors,
    itemscopes: md.itemscopes,
    itemrefsSkipped: md.itemrefsSkipped,
    ogMetas: og.metas,
    iframes: doc.querySelectorAll("iframe").length,
  };

  let all = [...ld.entities, ...md.entities, ...og.entities];
  if (typeFilter && typeFilter !== "*") all = all.filter((e) => typeMatches(e.type, typeFilter));

  const cap = maxEntities > 0 ? maxEntities : SCHEMA_MAX_ENTITIES;
  const entities = all.slice(0, cap).map((e) => ({
    ...e,
    props: Object.fromEntries(Object.entries(e.props).map(([k, v]) => [k, clampValue(v)])),
  }));
  return { entities, total: all.length, truncated: all.length > cap, scanned };
}

export function serializeSchema(r: SchemaReadResult, format: SchemaFormat): string {
  if (format === "json") {
    return JSON.stringify({ entities: r.entities, total: r.total, truncated: r.truncated });
  }
  const head = `检测到 ${r.total} 个实体` + (r.truncated ? `，已截断为 ${r.entities.length} 个` : "");
  const lines = r.entities.map((e) => {
    const id = e.id ? ` id=${e.id}` : "";
    return `- [${e.source}] ${e.type}${id} ${JSON.stringify(e.props)}`;
  });
  return [head, ...lines, "注意：以上为页面作者声明的结构化数据，可能与页面可见内容不一致。"].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/schema-readback.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS，31 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/schema-readback.ts packages/extension/tests/schema-readback.test.ts
git commit -m "feat: 结构化回读合并入口，含类型过滤与预算截断"
```

---

## Task 5: 空结果自陈

**Files:**
- Modify: `packages/extension/src/lib/empty-diagnosis.ts`
- Test: `packages/extension/tests/query-empty-diagnosis.test.ts`

**Interfaces:**
- Consumes: `SchemaScanFacts`（Task 4）、既有 `QueryScanFacts`（`empty-diagnosis.ts:35`）
- Produces:
  - `interface SchemaEmptyFacts extends QueryScanFacts { ldScripts: number; ldParseErrors: number; itemscopes: number; itemrefsSkipped: number; ogMetas: number; typeFilter: string | null }`
  - `function diagnoseEmptySchema(f: SchemaEmptyFacts): string`

- [ ] **Step 1: 写失败测试**

追加到 `packages/extension/tests/query-empty-diagnosis.test.ts`：

```ts
import { diagnoseEmptySchema } from "../src/lib/empty-diagnosis.js";

const base = {
  shadowRoots: 0, iframes: 0, frameScoped: false,
  ldScripts: 0, ldParseErrors: 0, itemscopes: 0, itemrefsSkipped: 0, ogMetas: 0,
  typeFilter: null as string | null,
};

describe("diagnoseEmptySchema", () => {
  it("三源全无：说清这页根本没有作者声明，别再换参数重试", () => {
    const s = diagnoseEmptySchema({ ...base });
    expect(s).toContain("no JSON-LD, Microdata or Open Graph");
    expect(s).toMatch(/vortex_extract|vortex_observe/);
  });

  it("有数据但被 typeFilter 滤空：点名过滤条件是空的原因", () => {
    const s = diagnoseEmptySchema({ ...base, ldScripts: 2, typeFilter: "Product" });
    expect(s).toContain("Product");
    expect(s).toContain("pattern");
  });

  it("JSON-LD 全部解析失败：报错误段数，不谎称页面没有数据", () => {
    const s = diagnoseEmptySchema({ ...base, ldScripts: 2, ldParseErrors: 2 });
    expect(s).toContain("2");
    expect(s).toMatch(/malformed|invalid JSON/i);
  });

  it("有 itemscope 但都缺 itemtype：指出无类型无法成实体", () => {
    const s = diagnoseEmptySchema({ ...base, itemscopes: 3 });
    expect(s).toContain("itemtype");
  });

  it("跳过了 itemref：如实报数", () => {
    expect(diagnoseEmptySchema({ ...base, itemscopes: 1, itemrefsSkipped: 1 })).toContain("itemref");
  });

  it("同页有 iframe 且未指定 frameId：沿用既有 iframe 提示", () => {
    expect(diagnoseEmptySchema({ ...base, iframes: 2 })).toContain("frameId");
  });

  it("已指定 frameId：不再劝去传 frameId", () => {
    expect(diagnoseEmptySchema({ ...base, iframes: 2, frameScoped: true })).not.toContain("pass frameId");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/query-empty-diagnosis.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `diagnoseEmptySchema is not a function`

- [ ] **Step 3: 实现最小代码**

追加到 `packages/extension/src/lib/empty-diagnosis.ts`（`iframeNote` 已在 `:55`，直接复用）：

```ts
export interface SchemaEmptyFacts extends QueryScanFacts {
  ldScripts: number;
  ldParseErrors: number;
  itemscopes: number;
  itemrefsSkipped: number;
  ogMetas: number;
  typeFilter: string | null;
}

export function diagnoseEmptySchema(f: SchemaEmptyFacts): string {
  const parts: string[] = [];
  const found = f.ldScripts > 0 || f.itemscopes > 0 || f.ogMetas > 0;

  if (!found) {
    parts.push(
      "This frame declares no JSON-LD, Microdata or Open Graph data — the page author published none. " +
        "Call vortex_extract for visible content, or vortex_observe for interactive elements.",
    );
  } else {
    parts.push(
      `Scanned ${f.ldScripts} JSON-LD script(s), ${f.itemscopes} itemscope element(s) and ${f.ogMetas} og: meta(s).`,
    );
    if (f.typeFilter && f.typeFilter !== "*") {
      parts.push(`Nothing matched type "${f.typeFilter}" — pass pattern:"*" to list every declared entity.`);
    }
    if (f.ldParseErrors > 0) {
      parts.push(`${f.ldParseErrors} JSON-LD block(s) contained malformed JSON and were skipped.`);
    }
    if (f.itemscopes > 0) {
      parts.push("Microdata items without an itemtype attribute are skipped — they carry no entity type.");
    }
    if (f.itemrefsSkipped > 0) {
      parts.push(`${f.itemrefsSkipped} item(s) use itemref; cross-node references are not resolved.`);
    }
  }
  const iframes = iframeNote(f);
  if (iframes) parts.push(iframes);
  return parts.join(" ");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/query-empty-diagnosis.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/lib/empty-diagnosis.ts packages/extension/tests/query-empty-diagnosis.test.ts
git commit -m "feat: mode=schema 空结果自陈，区分没有声明与被过滤空"
```

---

## Task 6: query.ts 内联 probe、mode 接线与 parity 守卫

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（`:1297-1306` 白名单、`:1466` 之后加分支、文件末尾附近加 `schemaProbeFunc`）
- Create: `packages/extension/tests/query-schema-parity.test.ts`
- Test: `packages/extension/tests/query-handler.test.ts`

**Interfaces:**
- Consumes: `readPageSchema` / `serializeSchema` / `SchemaScanFacts`（Task 4）、`diagnoseEmptySchema`（Task 5）、既有 `withDiagnosis`（`packages/shared/src/diagnosis.ts:26`）
- Produces:
  - `export const schemaProbeFunc: (pattern: string, format: string, maxEntities: number) => { text: string; total: number; scanned: SchemaScanFacts } | { error: string }`
  - handler 返回形状：`withDiagnosis({ text, total, truncated }, diagnosis | null)`

- [ ] **Step 1: 写失败测试**

创建 `packages/extension/tests/query-schema-parity.test.ts`：

```ts
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
```

追加到 `packages/extension/tests/query-handler.test.ts`（沿用该文件既有的 router + mock chrome 范式；若文件内已有 `mkChrome`/`callQuery` 之类 helper，复用它们，不要另起一套）：

```ts
describe("vortex_query mode=schema", () => {
  it("mode 白名单接受 schema，不再抛 INVALID_PARAMS", async () => {
    const res = await callQuery({ mode: "schema", pattern: "*" }, () => ({
      text: "检测到 1 个实体", total: 1,
      scanned: { ldScripts: 1, ldParseErrors: 0, itemscopes: 0, itemrefsSkipped: 0, ogMetas: 0 },
    }));
    expect(res).toMatchObject({ text: "检测到 1 个实体", total: 1 });
  });

  it("total=0 时挂上自陈，且自陈里带上了 page-side 采集的 scanned 事实", async () => {
    const res = await callQuery({ mode: "schema", pattern: "Product" }, () => ({
      text: "检测到 0 个实体", total: 0,
      scanned: { ldScripts: 2, ldParseErrors: 0, itemscopes: 0, itemrefsSkipped: 0, ogMetas: 0 },
    }));
    const diag = (res as Record<string, unknown>).__vtxDiagnosis as string;
    expect(diag).toContain("2 JSON-LD script(s)");
    expect(diag).toContain("Product");
  });

  it("total>0 时形状与从前一致：不包裹、无 scanned 泄漏", async () => {
    const res = await callQuery({ mode: "schema", pattern: "*" }, () => ({
      text: "检测到 3 个实体", total: 3,
      scanned: { ldScripts: 1, ldParseErrors: 0, itemscopes: 2, itemrefsSkipped: 0, ogMetas: 1 },
    })) as Record<string, unknown>;
    expect(res).not.toHaveProperty("__vtxDiagnosis");
    expect(res).not.toHaveProperty("scanned");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run tests/query-schema-parity.test.ts tests/query-handler.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — parity 测试报找不到 `[inline schema-readback]`；handler 测试报 `mode must be 'text', 'css', ...`

- [ ] **Step 3: 实现最小代码**

**3a.** 在 `packages/extension/src/handlers/query.ts` 里 `flowProbeFunc` 之后加内联副本。它必须完全自包含——把 Task 1-4 的实现整体内联，常量直接写在函数体内：

```ts
/**
 * 结构化数据回读探针。真源 src/page-side/schema-readback.ts;此处是注入用的自包含副本
 * (executeScript 注入丢模块作用域,不能 import),parity 由 query-schema-parity.test.ts 守。
 * [inline schema-readback]
 */
export const schemaProbeFunc = (
  pattern: string,
  format: string,
  maxEntities: number,
):
  | { text: string; total: number; truncated: boolean; scanned: Record<string, number> }
  | { error: string } => {
  try {
    const doc = document;
    const SCHEMA_MAX_VALUE_CHARS = 500;

    interface E { type: string; props: Record<string, unknown>; source: string; untrusted: true; id?: string }

    const firstType = (raw: unknown): string | null => {
      if (typeof raw === "string" && raw.trim()) return raw.trim();
      if (Array.isArray(raw)) for (const t of raw) if (typeof t === "string" && t.trim()) return t.trim();
      return null;
    };
    const toEntity = (obj: Record<string, unknown>, source: string): E | null => {
      const type = firstType(obj["@type"]);
      if (!type) return null;
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "@context" || k === "@id") continue;
        props[k] = v;
      }
      if (!Array.isArray(obj["@type"])) delete props["@type"];
      const e: E = { type, props, source, untrusted: true };
      const id = obj["@id"];
      if (typeof id === "string" && id) e.id = id;
      return e;
    };
    const flattenLd = (parsed: unknown): Record<string, unknown>[] => {
      if (Array.isArray(parsed)) return parsed.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
      if (!parsed || typeof parsed !== "object") return [];
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) {
        return (obj["@graph"] as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
      }
      return [obj];
    };

    const ldScriptEls = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    const ldEntities: E[] = [];
    let parseErrors = 0;
    ldScriptEls.forEach((s, i) => {
      let parsed: unknown;
      try { parsed = JSON.parse(s.textContent || ""); } catch { parseErrors++; return; }
      for (const obj of flattenLd(parsed)) {
        const e = toEntity(obj, `jsonld:${i}`);
        if (e) ldEntities.push(e);
      }
    });

    const SRC_TAGS = new Set(["IMG", "AUDIO", "EMBED", "IFRAME", "SOURCE", "TRACK", "VIDEO"]);
    const HREF_TAGS = new Set(["A", "AREA", "LINK"]);
    const readItem = (scope: Element): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      const t = scope.getAttribute("itemtype");
      if (t) out["@type"] = t;
      for (const el of Array.from(scope.querySelectorAll("[itemprop]"))) {
        const start = el.hasAttribute("itemscope") ? el.parentElement : el;
        if ((start ? start.closest("[itemscope]") : null) !== scope) continue;
        let value: unknown;
        if (el.hasAttribute("itemscope")) value = readItem(el);
        else {
          const tag = el.tagName;
          if (tag === "META") value = el.getAttribute("content") || "";
          else if (HREF_TAGS.has(tag)) value = el.getAttribute("href") || "";
          else if (SRC_TAGS.has(tag)) value = el.getAttribute("src") || "";
          else if (tag === "OBJECT") value = el.getAttribute("data") || "";
          else if (tag === "DATA" || tag === "METER") value = el.getAttribute("value") || "";
          else if (tag === "TIME") value = el.getAttribute("datetime") || (el.textContent || "").trim();
          else value = (el.textContent || "").trim();
        }
        for (const name of (el.getAttribute("itemprop") || "").split(/\s+/).filter(Boolean)) {
          const prev = out[name];
          if (prev === undefined) out[name] = value;
          else if (Array.isArray(prev)) prev.push(value);
          else out[name] = [prev, value];
        }
      }
      return out;
    };
    const scopes = Array.from(doc.querySelectorAll("[itemscope]"));
    const mdEntities: E[] = [];
    let itemrefsSkipped = 0;
    let mdIdx = 0;
    for (const scope of scopes) {
      if (scope.hasAttribute("itemref")) itemrefsSkipped++;
      if (scope.hasAttribute("itemprop")) continue;
      const type = scope.getAttribute("itemtype");
      if (!type) continue;
      const { "@type": _t, ...props } = readItem(scope);
      const e: E = { type, props, source: `microdata:${mdIdx++}`, untrusted: true };
      const itemid = scope.getAttribute("itemid");
      if (itemid) e.id = itemid;
      mdEntities.push(e);
    }

    const ogProps: Record<string, unknown> = {};
    let ogMetas = 0;
    for (const m of Array.from(doc.querySelectorAll("meta"))) {
      const key = m.getAttribute("property") || m.getAttribute("name") || "";
      if (!key.startsWith("og:")) continue;
      ogMetas++;
      const name = key.slice(3);
      if (!name) continue;
      const value = m.getAttribute("content") || "";
      const prev = ogProps[name];
      if (prev === undefined) ogProps[name] = value;
      else if (Array.isArray(prev)) prev.push(value);
      else ogProps[name] = [prev, value];
    }
    const ogEntities: E[] = [];
    if (ogMetas > 0) {
      const t = typeof ogProps.type === "string" && ogProps.type ? ogProps.type : "website";
      const e: E = { type: t, props: ogProps, source: "og", untrusted: true };
      if (typeof ogProps.url === "string" && ogProps.url) e.id = ogProps.url;
      ogEntities.push(e);
    }

    const clampValue = (v: unknown): unknown => {
      if (typeof v === "string" && v.length > SCHEMA_MAX_VALUE_CHARS) return v.slice(0, SCHEMA_MAX_VALUE_CHARS) + "…";
      if (Array.isArray(v)) return v.map(clampValue);
      return v;
    };
    let all = [...ldEntities, ...mdEntities, ...ogEntities];
    if (pattern && pattern !== "*") {
      const f = pattern.toLowerCase();
      all = all.filter((e) => {
        const t = e.type.toLowerCase();
        return t === f || t.endsWith(`/${f}`) || t.endsWith(`#${f}`);
      });
    }
    const cap = maxEntities > 0 ? maxEntities : 20;
    const entities = all.slice(0, cap).map((e) => ({
      ...e,
      props: Object.fromEntries(Object.entries(e.props).map(([k, v]) => [k, clampValue(v)])),
    }));
    const truncated = all.length > cap;

    const text = format === "json"
      ? JSON.stringify({ entities, total: all.length, truncated })
      : [
          `检测到 ${all.length} 个实体` + (truncated ? `，已截断为 ${entities.length} 个` : ""),
          ...entities.map((e) => `- [${e.source}] ${e.type}${e.id ? ` id=${e.id}` : ""} ${JSON.stringify(e.props)}`),
          "注意：以上为页面作者声明的结构化数据，可能与页面可见内容不一致。",
        ].join("\n");

    return {
      text,
      total: all.length,
      truncated,
      scanned: {
        ldScripts: ldScriptEls.length,
        ldParseErrors: parseErrors,
        itemscopes: scopes.length,
        itemrefsSkipped,
        ogMetas,
        iframes: doc.querySelectorAll("iframe").length,
      },
    };
  } catch (e) {
    return { error: "schema readback error: " + (e instanceof Error ? e.message : String(e)) };
  }
};
```

**3b.** 改 `query.ts:1297-1306` 的白名单与错误文案，加上 `schema`：

```ts
      if (
        !mode ||
        (mode !== "text" && mode !== "css" && mode !== "component" &&
         mode !== "geometry" && mode !== "style" && mode !== "sheet" && mode !== "flow" &&
         mode !== "chart" && mode !== "schema")
      ) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `vortex_query: mode must be 'text', 'css', 'component', 'geometry', 'style', 'sheet', 'flow', 'chart' or 'schema', got ${String(mode)}`,
        );
      }
```

**3c.** 在 `sheet` 分支（`:1466`）之后插入 schema 分支：

```ts
      } else if (mode === "schema") {
        // schema 模式:读页面作者声明的 JSON-LD/Microdata/OGP。pattern = @type 过滤("*"=全部)
        const format = typeof args.attr === "string" ? args.attr : "summary";
        const maxEntities = Math.min((args.maxResults as number | undefined) ?? 20, 100);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: schemaProbeFunc,
          args: [pattern, format, maxEntities],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { text: string; total: number; truncated: boolean; scanned: Record<string, number> }
          | { error: string }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage schema: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage schema error: ${res.error}`);
        }
        // scanned 只服务于零命中自陈,不进载荷 —— 有命中时形状与其他 mode 一致
        const { scanned, ...payload } = res;
        return withDiagnosis(
          payload,
          res.total === 0
            ? diagnoseEmptySchema({
                ...(scanned as unknown as {
                  ldScripts: number; ldParseErrors: number; itemscopes: number;
                  itemrefsSkipped: number; ogMetas: number; iframes: number;
                }),
                // schema 三源都不在 shadow 里(JSON-LD 在 head，OGP 在 meta)，恒 0
                shadowRoots: 0,
                frameScoped: frameId != null,
                typeFilter: pattern === "*" ? null : pattern,
              })
            : null,
        );
      }
```

**3d.** 在 `query.ts` 顶部导入 `diagnoseEmptySchema`（与既有 `diagnoseEmptyQueryText` 同一 import 语句）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension exec vitest run --maxWorkers=2 --minWorkers=1`
Expected: PASS，全量扩展测试绿（含 depcruise 不变式）

再跑一次构建确认内联副本能编译进产物：

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension build`
Expected: 成功，`dist/page-side/` 存在

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/extension/tests/query-schema-parity.test.ts packages/extension/tests/query-handler.test.ts packages/extension/src/page-side/schema-readback.ts packages/extension/tests/schema-readback.test.ts
git commit -m "feat: vortex_query 接入 mode=schema"
```

---

## Task 7: MCP 公开面

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:454`
- Modify: `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`（抬 cap + 记账注释）
- Test: `packages/mcp/tests/`（新建 `query-schema-mode.test.ts`）

> **2026-08-13 订正**：本任务初版写了一条 `Buffer.byteLength(JSON.stringify(PUBLIC_TOOLS)) <= 4500` 的断言，**两处都错**——4500 是 v0.6 的旧数（现行 cap 10200），measure 对象也不对（真源用的是 `getToolDefs()` 映射出的 tools/list payload）。预算的单一真源是 `I15.tools-list-budget.test.ts`，不要在别处复制第二份。

**Interfaces:**
- Consumes: Task 6 的 handler
- Produces: 公开 `vortex_query` schema 的 `mode` enum 含 `"schema"`

- [ ] **Step 1: 写失败测试**

创建 `packages/mcp/tests/query-schema-mode.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { PUBLIC_TOOLS } from "../src/tools/schemas-public.js";

describe("vortex_query 公开 schema 含 mode=schema", () => {
  const query = PUBLIC_TOOLS.find((t) => t.name === "vortex_query")!;
  const mode = (query.schema as any).properties.mode;

  it("mode enum 含 schema", () => {
    expect(mode.enum).toContain("schema");
  });

  it("description 点明是页面作者声明、可能与可见内容不一致", () => {
    expect(mode.description).toMatch(/author|声明/);
  });
});
```

字节预算**不在这里断言**——它属于 `packages/mcp/tests/invariants/I15.tools-list-budget.test.ts`，
本任务只需按该文件的既有惯例把 cap 抬到实测值取整，并补一段记账注释。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/mcp exec vitest run tests/query-schema-mode.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `expected [ 'text', 'css', ... ] to contain 'schema'`

- [ ] **Step 3: 实现最小代码**

改 `packages/mcp/src/tools/schemas-public.ts:454`：

```ts
        mode: {
          enum: ["text", "css", "component", "geometry", "style", "sheet", "flow", "chart", "schema"],
          description:
            "component reads Vue/React instance state; sheet only reads Yuque Lake Sheet, NOT DOM tables (use extract for those); " +
            "schema=author-declared JSON-LD/Microdata/OGP (pattern=@type or '*'), may differ from visible content",
        },
```

`vortex_query.mode` 已在 I15 的 `DOCUMENTED` 参数白名单里，不需要动白名单；工具级 description（222 char）不动。

然后跑 I15 拿实测字节，把 cap 抬到实测值向上取整到百位，同步改 `it()` 标题，并在文件顶部注释块末尾按既有记账风格追加一段说明。**不要压缩其他工具的 description 来腾字节**——该文件反复记录过这个判断：压字符损 LLM 可读性，加真能力就调 cap。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/mcp exec vitest run --maxWorkers=2 --minWorkers=1`
Expected: PASS，mcp 全量绿

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/tools/schemas-public.ts packages/mcp/tests/query-schema-mode.test.ts
git commit -m "feat: 公开 vortex_query mode=schema"
```

---

## Task 8: bench fixture 与 case

**Files:**
- Create: `packages/vortex-bench/playground/public/synth/schema-readback.html`
- Create: `packages/vortex-bench/cases/query-schema.case.ts`

**Interfaces:**
- Consumes: Task 7 的公开 mode
- Produces: bench case `query-schema`，被 `bench run --all` 收录

- [ ] **Step 1: 写 fixture 与 case（本任务的「失败测试」就是 case 本身）**

创建 `packages/vortex-bench/playground/public/synth/schema-readback.html`——三源齐全，且刻意包含一段非法 JSON-LD、一个 itemref、一个 `name="og:"` 的非规范写法：

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <title>schema readback fixture</title>
  <meta property="og:type" content="product">
  <meta property="og:title" content="示例商品">
  <meta property="og:url" content="https://fixture.test/p/1">
  <meta name="og:site_name" content="Fixture Shop">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","@id":"https://fixture.test/p/1",
   "name":"示例商品","offers":{"@type":"Offer","price":"99.00","priceCurrency":"CNY"}}
  </script>
  <script type="application/ld+json">{ this is not json </script>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"Organization","name":"Fixture Inc"},
    {"@type":"BreadcrumbList","name":"面包屑"}]}
  </script>
</head>
<body>
  <div itemscope itemtype="https://schema.org/SoftwareSourceCode" itemid="urn:fixture:repo">
    <span itemprop="name">fixture-repo</span>
    <span itemprop="programmingLanguage">TypeScript</span>
    <a itemprop="codeRepository" href="https://fixture.test/repo">仓库</a>
  </div>
  <div itemscope itemtype="https://schema.org/Review" itemref="ext-author">
    <span itemprop="reviewBody">还行</span>
  </div>
  <span id="ext-author" itemprop="author">某人</span>
  <p>页面可见文本：这一段没有任何结构化声明。</p>
</body>
</html>
```

创建 `packages/vortex-bench/cases/query-schema.case.ts`：

```ts
// mode=schema 结构化回读。fixture 三源齐全，且含非法 JSON-LD / itemref / name="og:" 非规范写法。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "query-schema",
  playgroundPath: "/synth/schema-readback.html",
  tier: "easy",
  async run(ctx) {
    const all = extractText(await ctx.call("vortex_query", { mode: "schema", pattern: "*", attr: "json" }));
    const parsed = JSON.parse(all) as {
      entities: { type: string; props: Record<string, unknown>; source: string; untrusted: boolean; id?: string }[];
      total: number;
    };

    const bySource = (p: string) => parsed.entities.filter((e) => e.source.startsWith(p));
    ctx.assert(bySource("jsonld").length === 3, `JSON-LD 应出 3 个实体(Product/Organization/BreadcrumbList)，实际 ${bySource("jsonld").length}`);
    ctx.assert(bySource("microdata").length === 2, `Microdata 应出 2 个实体，实际 ${bySource("microdata").length}`);
    ctx.assert(bySource("og").length === 1, `OGP 应出 1 个实体，实际 ${bySource("og").length}`);
    ctx.assert(parsed.entities.every((e) => e.untrusted === true), "所有实体必须带 untrusted");

    const product = parsed.entities.find((e) => e.type.endsWith("Product"));
    ctx.assert(product?.id === "https://fixture.test/p/1", `Product 的 @id 应被提取，实际 ${product?.id}`);
    ctx.assert(
      JSON.stringify(product?.props.offers).includes("99.00"),
      `嵌套 offers 应原样保留在 props，实际 ${JSON.stringify(product?.props.offers)}`,
    );

    // 非规范 name="og:site_name" 必须被收，否则说明双属性回退失效
    const og = bySource("og")[0];
    ctx.assert(og.props.site_name === "Fixture Shop", `name="og:" 写法应被收，实际 ${JSON.stringify(og.props)}`);

    // 非法 JSON-LD 只废那一段，其余三个实体照出 —— 上面已断言，这里断言不整体报错
    ctx.assert(parsed.total === 6, `合计应为 6 个实体，实际 ${parsed.total}`);

    // 过滤空时必须自陈，且指出是过滤条件的问题而非页面没有数据
    const missRaw = await ctx.call("vortex_query", { mode: "schema", pattern: "NoSuchType" });
    const missText = JSON.stringify(missRaw);
    ctx.assert(missText.includes("NoSuchType"), `过滤空时自陈应点名过滤条件。实际:\n${missText.slice(0, 400)}`);
    ctx.assert(missText.includes("JSON-LD script"), `过滤空时自陈应报出扫到的事实。实际:\n${missText.slice(0, 400)}`);
  },
};
export default def;
```

- [ ] **Step 2: 跑 case 确认失败**

先起 playground：`cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/bench playground`（后台常驻）
再跑：`cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/bench bench run query-schema`
Expected: FAIL —— 若 Task 6/7 的产物尚未加载进浏览器，会报 mode 非法；这一步的目的是确认「扩展没重载 = case 红」，从而证明 case 真的在验证新代码。

- [ ] **Step 3: 重载扩展让新产物生效**

```bash
cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/extension build
```
然后触发扩展重载（`vortex_dev_reload`，需 `--caps=dev`），或在 `chrome://extensions` 手动 reload。MV3 service worker 不会自动接管新产物。

- [ ] **Step 4: 跑 case 确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/bench bench run query-schema`
Expected: PASS

再跑全量确认没有回归：
Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/bench bench run --all`
Expected: 与 `reports/baseline.json` 相比无新增失败

- [ ] **Step 5: 提交**

```bash
git add packages/vortex-bench/playground/public/synth/schema-readback.html packages/vortex-bench/cases/query-schema.case.ts
git commit -m "test: 补 mode=schema 的 bench fixture 与 case"
```

---

## Task 9: 外部基线对照 runner

**Files:**
- Create: `packages/vortex-bench/src/runner/external-baseline.ts`
- Create: `reports/external-baseline-2026-08/README.md`
- Modify: `packages/vortex-bench/src/index.ts`（注册 `external-baseline` 子命令）

**Interfaces:**
- Consumes: `createMcpConnection` / `closeMcpConnection`（`packages/vortex-bench/src/runner/mcp-client.ts:19,43`）
- Produces:
  - `interface BaselineSample { tool: string; page: string; bytes: number; durationMs: number; ok: boolean; error?: string }`
  - `async function runExternalBaseline(pages: string[]): Promise<BaselineSample[]>`

- [ ] **Step 1: 写失败测试**

创建 `packages/vortex-bench/tests/external-baseline.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { summarize, type BaselineSample } from "../src/runner/external-baseline.js";

describe("summarize", () => {
  const samples: BaselineSample[] = [
    { tool: "vortex", page: "/a", bytes: 1000, durationMs: 100, ok: true },
    { tool: "vortex", page: "/b", bytes: 2000, durationMs: 300, ok: true },
    { tool: "chrome-devtools-mcp", page: "/a", bytes: 5000, durationMs: 200, ok: true },
    { tool: "chrome-devtools-mcp", page: "/b", bytes: 7000, durationMs: 400, ok: false, error: "boom" },
  ];

  it("按工具聚合字节与耗时，失败样本计入 failures 且不进均值", () => {
    const s = summarize(samples);
    expect(s["vortex"]).toMatchObject({ pages: 2, failures: 0, totalBytes: 3000 });
    expect(s["chrome-devtools-mcp"]).toMatchObject({ pages: 2, failures: 1, totalBytes: 5000 });
  });

  it("报告恒带环境不对等声明，防止被当成 parity 数字引用", () => {
    const s = summarize(samples);
    expect(s.__caveat).toMatch(/不对等|not comparable/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/bench exec vitest run tests/external-baseline.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — 找不到模块

- [ ] **Step 3: 实现最小代码**

创建 `packages/vortex-bench/src/runner/external-baseline.ts`：

```ts
// 外部基线对照：同一组 fixture 页面，vortex 与 chrome-devtools-mcp 各观察一次，
// 比输出字节与端到端耗时。
//
// 两者的浏览器不是同一个(vortex 接管真实已登录 Chrome，chrome-devtools-mcp 自启或
// 走 --browser-url)，任何数字都不能当 parity 引用 —— 故 summarize 恒带 __caveat。
import { createMcpConnection, closeMcpConnection } from "./mcp-client.js";

export interface BaselineSample {
  tool: string;
  page: string;
  bytes: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ToolSummary {
  pages: number;
  failures: number;
  totalBytes: number;
  avgDurationMs: number;
}

export const CAVEAT =
  "环境不对等：vortex 接管真实已登录 Chrome，chrome-devtools-mcp 使用自启浏览器。" +
  "字节与耗时仅供量级参考，不构成 parity（not comparable as parity）。";

export function summarize(samples: BaselineSample[]): Record<string, ToolSummary> & { __caveat: string } {
  const out: Record<string, ToolSummary> = {};
  for (const s of samples) {
    const t = (out[s.tool] ??= { pages: 0, failures: 0, totalBytes: 0, avgDurationMs: 0 });
    t.pages++;
    if (!s.ok) { t.failures++; continue; }
    t.totalBytes += s.bytes;
    t.avgDurationMs += s.durationMs;
  }
  for (const t of Object.values(out)) {
    const ok = t.pages - t.failures;
    t.avgDurationMs = ok > 0 ? Math.round(t.avgDurationMs / ok) : 0;
  }
  return { ...out, __caveat: CAVEAT };
}

const VORTEX = { command: "node", args: ["packages/mcp/dist/src/server.js"] };
const CDT = { command: "npx", args: ["-y", "chrome-devtools-mcp@1.7.0"] };

async function sampleOne(
  cfg: { command: string; args: string[] },
  tool: string,
  page: string,
  call: (conn: Awaited<ReturnType<typeof createMcpConnection>>, page: string) => Promise<unknown>,
): Promise<BaselineSample> {
  const started = Date.now();
  const conn = await createMcpConnection(cfg);
  try {
    const res = await call(conn, page);
    return { tool, page, bytes: Buffer.byteLength(JSON.stringify(res), "utf8"), durationMs: Date.now() - started, ok: true };
  } catch (e) {
    return { tool, page, bytes: 0, durationMs: Date.now() - started, ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await closeMcpConnection(conn);
  }
}

export async function runExternalBaseline(pages: string[]): Promise<BaselineSample[]> {
  const out: BaselineSample[] = [];
  for (const page of pages) {
    out.push(await sampleOne(VORTEX, "vortex", page, async (conn, p) => {
      await conn.callTool("vortex_navigate", { url: p });
      return conn.callTool("vortex_observe", {});
    }));
    out.push(await sampleOne(CDT, "chrome-devtools-mcp", page, async (conn, p) => {
      await conn.callTool("navigate_page", { url: p });
      return conn.callTool("take_snapshot", {});
    }));
  }
  return out;
}
```

> 若 `chrome-devtools-mcp` 的工具名与上面不符，先跑一次 `npx -y chrome-devtools-mcp@1.7.0` 并读它的 `tools/list` 拿到真名再改；**不要猜**，猜错会让整轮对照静默失败并被记成「外部工具更差」。

创建 `reports/external-baseline-2026-08/README.md`，先只写口径与不对等声明，数字由 runner 产出后再填。

在 `packages/vortex-bench/src/index.ts` 注册子命令 `external-baseline`，参数为页面 URL 列表，输出 JSON 到 `reports/external-baseline-2026-08/latest.json`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/bench exec vitest run --maxWorkers=2 --minWorkers=1`
Expected: PASS

实跑一轮（playground 需在跑）：
Run: `cd /Users/lg/workspace/vortex && pnpm --filter @vortex-browser/bench bench external-baseline http://localhost:5173/synth/schema-readback.html http://localhost:5173/el-table`
Expected: 产出 `latest.json`，两个工具各有样本；若 chrome-devtools-mcp 连不上，样本 `ok:false` 且 `error` 有原文——如实记录，不要静默丢弃。

- [ ] **Step 5: 提交**

```bash
git add packages/vortex-bench/src/runner/external-baseline.ts packages/vortex-bench/tests/external-baseline.test.ts packages/vortex-bench/src/index.ts reports/external-baseline-2026-08/
git commit -m "test: 建立与 chrome-devtools-mcp 的外部对照基线"
```

---

## Task 10: WebMCP / APC 只读探测 spike

**Files:**
- Create: `reports/external-baseline-2026-08/experimental-domains-probe.md`

**Interfaces:**
- Consumes: 已有的 `chrome.debugger` 会话（`packages/extension/src/lib/debugger-manager.ts`）
- Produces: 一份探测记录，**不产出任何生产代码**

- [ ] **Step 1: 探测 CDP domain 可用性**

在已连接的真实浏览器上（本机 Chrome 151 / Edge），通过 `vortex_evaluate` 之外的路径——用 `chrome://inspect` 或临时脚本经 `chrome.debugger.sendCommand` 依次尝试：

- `Schema.getDomains`（列出当前会话可见的全部 domain）
- `WebMCP.enable`
- `Page.getAnnotatedPageContent`（`{ includeActionableInformation: true }`）

对每一项记录：是否返回错误、错误原文、返回体大小。

- [ ] **Step 2: 在有 WebMCP 声明的页面上复测**

打开 WebMCP 官方 demo（若 Origin Trial 未启用则记录「无法验证」而不是留空），观察 `WebMCP.toolsAdded` 是否有事件。

- [ ] **Step 3: 写探测记录**

`reports/external-baseline-2026-08/experimental-domains-probe.md` 必须包含：

- 浏览器 product / version（本机实测为 Chrome 151.0.7922.110）
- 每个命令的可用性、错误原文、payload 字节
- APC 的 base64 protobuf 能否在无 Chromium 内部 proto 定义的情况下解析（预期：不能，如实写）
- 一句结论：在当前状态下**是否值得**进入 v-next 路线；证据不足就写「证据不足」

- [ ] **Step 4: 自检**

确认这份记录里没有出现任何「建议实现 XX adapter」的结论——本任务的产出只是事实，路线决策留给下一次关卡。

- [ ] **Step 5: 提交**

```bash
git add reports/external-baseline-2026-08/experimental-domains-probe.md
git commit -m "docs: WebMCP 与 getAnnotatedPageContent 只读探测记录"
```

---

## Self-Review

**1. 思路文档覆盖**

| 思路文档要求 | 落在哪 |
|---|---|
| 判据 1（5 类真站各出 ≥1 实体，`@type` 正确） | Task 8 用 fixture 覆盖三源；真站验证在 Task 9 实跑时补记，fixture 的实体形状取自 bilibili/GitHub 实测语料 |
| 判据 2（空 + 自陈） | Task 5 全部 7 个用例、Task 6 的 handler 测试、Task 8 case 尾部两条断言 |
| 判据 3（单段非法 JSON-LD 不牵连其余） | Task 1 第 5 个用例、Task 8 fixture 含非法段 |
| 判据 4（source + untrusted） | Task 1/2/3 各自断言，Task 8 case 全量断言 `untrusted === true` |
| 判据 5（预算 + truncated） | Task 4 两个截断用例、Task 7 的 4500 字节测试 |
| 不做 itemref | Task 2 第 7 个用例 + Task 5 自陈报数 |
| 不建 edges 图 | Task 1 第 6 个用例（嵌套对象原样留 props） |
| OGP 双属性（实测发现） | Task 3 第 2 个用例、Task 6 parity 断言、Task 8 fixture |
| O12 外部基线 + 不对等声明 | Task 9 |
| WebMCP/APC 只读探测 | Task 10 |

**2. Placeholder 扫描**

无 TBD / TODO / 「类似 Task N」/ 「加上适当的错误处理」。唯一一处需要执行者自行确认的外部事实，是 Task 9 里 `chrome-devtools-mcp` 的工具名——那里明确写了「先跑 `tools/list` 拿真名，不要猜」，并说明了猜错的后果。

**3. 类型一致性**

- `SchemaEntity`（Task 1 定义）在 Task 2/3/4 中签名一致：`{ type, props, source, untrusted, id? }`
- `SchemaScanFacts`（Task 4）与 `SchemaEmptyFacts`（Task 5）的字段名一致：`ldScripts` / `ldParseErrors` / `itemscopes` / `itemrefsSkipped` / `ogMetas` / `iframes`；Task 5 额外继承 `QueryScanFacts` 的 `shadowRoots` / `frameScoped` 并加 `typeFilter`。`iframes` 由 `QueryScanFacts` 与 `SchemaScanFacts` 同名同义，展开时不冲突
- Task 6 内联副本的 `scanned` 字段名与真源 `SchemaScanFacts` 逐字一致（parity 测试不覆盖字段名，靠 handler 测试的 `diag` 断言兜住）
- `serializeSchema` / `readPageSchema` 在 Task 4 定义，Task 6 内联同名逻辑，无别名分裂
