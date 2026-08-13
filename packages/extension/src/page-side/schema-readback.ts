/**
 * Author: qingwa
 * Description: page-side 结构化数据回读真源。
 */

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
