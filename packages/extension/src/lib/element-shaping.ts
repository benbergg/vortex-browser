// 探针只产原始值,本模块负责还原三种旧返回形状。

export type RawElement = Record<string, unknown> & { index: number; tag: string };

export type RawProbeResult = {
  elements: RawElement[];
  total: number;
  showing: number;
  viewport?: { w: number; h: number };
  pair?: Record<string, boolean>;
  scanned?: { elements: number; shadowRoots: number; iframes: number };
  fontFaces?: Array<Record<string, string>>;
  fontFacesPartial?: boolean;
  fontFacesPartialReasons?: string[];
};

const CSS_ELEMENT_KEYS = ["index", "tag", "children_count"] as const;
const GEOMETRY_ELEMENT_KEYS = [
  "index", "tag", "bbox", "inViewport", "occluded", "occludedBy", "textClipped", "clippedByAncestor",
] as const;

// 只拷贝存在的键,避免缺席字段变成 undefined 属性。
function pick(src: RawElement, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

export function shapeCssResult(
  raw: RawProbeResult,
  opts: { attributes: string[] | null; includeText: boolean },
): {
  elements: Array<Record<string, unknown>>;
  total: number;
  showing: number;
  scanned?: { elements: number; shadowRoots: number; iframes: number };
} {
  const elements = raw.elements.map((e) => {
    const item = pick(e, CSS_ELEMENT_KEYS);
    if (opts.includeText && e.text !== undefined) item.text = e.text;
    // 空属性对象也保留,区分没请求与请求后无结果。
    if (opts.attributes != null && e.attrs !== undefined) item.attrs = e.attrs;
    return item;
  });
  return {
    elements,
    total: raw.total,
    showing: raw.showing,
    ...(raw.scanned ? { scanned: raw.scanned } : {}),
  };
}

export function shapeGeometryResult(raw: RawProbeResult): {
  viewport: { w: number; h: number };
  elements: Array<Record<string, unknown>>;
  pair?: Record<string, boolean>;
  total: number;
  showing: number;
} {
  return {
    viewport: raw.viewport ?? { w: 0, h: 0 },
    elements: raw.elements.map((e) => pick(e, GEOMETRY_ELEMENT_KEYS)),
    ...(raw.pair ? { pair: raw.pair } : {}),
    total: raw.total,
    showing: raw.showing,
  };
}

export function shapeStyleResult(
  raw: RawProbeResult,
  groups: string[],
): {
  elements: Array<Record<string, unknown>>;
  total: number;
  showing: number;
  fontFaces?: Array<Record<string, string>>;
  fontFacesPartial?: boolean;
  fontFacesPartialReasons?: string[];
} {
  // font 与 pseudo 的内部字段只在对应组请求时保留。
  const extra = [
    ...(groups.indexOf("font") !== -1 ? ["declaredFont", "fp"] : []),
    ...(groups.indexOf("pseudo") !== -1 ? ["pseudoRaw"] : []),
  ];
  const keys = ["index", "tag", ...groups, ...extra];
  return {
    elements: raw.elements.map((e) => pick(e, keys)),
    total: raw.total,
    showing: raw.showing,
    ...(raw.fontFaces ? { fontFaces: raw.fontFaces } : {}),
    ...(raw.fontFacesPartial !== undefined ? { fontFacesPartial: raw.fontFacesPartial } : {}),
    ...(raw.fontFacesPartialReasons ? { fontFacesPartialReasons: raw.fontFacesPartialReasons } : {}),
  };
}
