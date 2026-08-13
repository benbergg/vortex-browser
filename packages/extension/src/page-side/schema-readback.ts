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
