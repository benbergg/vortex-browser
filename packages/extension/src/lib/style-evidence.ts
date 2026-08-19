/**
 * Description: mode=style 的证据判据。探针只负责把原始 computed 值读回来,
 * 判定放在这里——page-side 注入代码不可测(jsdom 不支持伪元素,content 恒为 normal),
 * 判据抽成纯函数才能真断言。
 */

/** 伪元素上读回的原始 computed 值,字段与 styleProbeFunc 读的那批一一对应。 */
export interface PseudoComputed {
  content: string;
  display: string;
  visibility: string;
  opacity: string;
  backgroundImage: string;
  width: string;
  height: string;
}

/** 长度是否画得出东西:auto/空/0 都不算。 */
function hasPaintedLength(v: string): boolean {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0;
}

/**
 * 伪元素是否真的在渲染。
 * content 单独看会误收:display:none / visibility:hidden / opacity:0 的伪元素
 * content 照样有值(gamma.app 七例 spike 实测)。
 */
export function isPseudoRendered(cs: PseudoComputed): boolean {
  // normal 是 content 的初始值,伪元素上等价 none;Chrome 给 none,jsdom 给 normal
  const c = cs.content;
  if (c === "none" || c === "normal" || c === "") return false;
  if (cs.display === "none") return false;
  if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
  const op = parseFloat(cs.opacity);
  if (Number.isFinite(op) && op === 0) return false;

  if (c === '""' || c === "''") return hasEmptyContentPaint(cs);
  return true;
}

/** 空 content 要画出东西只能靠背景图或撑开的尺寸(图标块、分隔条、三角)。 */
function hasEmptyContentPaint(cs: PseudoComputed): boolean {
  const hasImage = cs.backgroundImage !== "" && cs.backgroundImage !== "none";
  return hasImage || (hasPaintedLength(cs.width) && hasPaintedLength(cs.height));
}

/** CDP CSS.getPlatformFontsForNode 返回的一项。 */
export interface PlatformFontUsage {
  familyName: string;
  postScriptName?: string;
  glyphCount: number;
  isCustomFont: boolean;
}

export interface RenderedFont {
  family: string;
  postScriptName: string;
  glyphCount: number;
  isWebFont: boolean;
}

/** 字体结论的来源:实测渲染结果,还是压根没拿到。 */
export type FontEvidence = "cdp-platform-fonts" | "unavailable";

export interface FontFacts {
  declared: string;
  rendered: RenderedFont[] | null;
  firstChoiceInUse: boolean | null;
  evidence: FontEvidence;
  reason?: string;
}

/** CSS 通用族没有对应的平台字体名,拿它跟 familyName 比必然不匹配。 */
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
  "math", "emoji", "fangsong", "inherit", "initial", "unset", "revert",
  // 系统字体关键字:平台名是 .SF NS 之类,跟关键字对不上,硬比必然误报"没用上"
  "-apple-system", "blinkmacsystemfont", "system-ui",
]);

/** 声明名与平台名常有空格/大小写差:声明 ESBuild,平台报 ES Build(gamma 实测)。 */
function normalizeFamily(name: string): string {
  return name.replace(/["']/g, "").replace(/\s+/g, "").toLowerCase();
}

/**
 * 平台 familyName 常带字重后缀(声明 "PP Mori" → 平台 "PP Mori Medium"),
 * 而 postScriptName 的连字符主干就是声明名(PPMori-Medium → PPMori)。两者任一命中即算用上。
 */
function matchesFamily(r: RenderedFont, declaredFirst: string): boolean {
  const want = normalizeFamily(declaredFirst);
  if (normalizeFamily(r.family) === want) return true;
  const stem = r.postScriptName.split("-")[0] ?? "";
  return stem !== "" && normalizeFamily(stem) === want;
}

function firstDeclaredFamily(declared: string): string | null {
  const first = declared.split(",")[0]?.trim() ?? "";
  if (first === "") return null;
  return GENERIC_FAMILIES.has(first.replace(/["']/g, "").toLowerCase()) ? null : first;
}

/**
 * 把 CDP 的平台字体用量整理成「声明 vs 实际」的结论。
 * rendered 传 null 表示没拿到(降级),此时所有判定都是 null——不能拿「没看」冒充「看过了」。
 */
export function buildFontEvidence(
  declared: string,
  fonts: PlatformFontUsage[] | null,
  reason?: string,
): FontFacts {
  if (fonts === null) {
    return { declared, rendered: null, firstChoiceInUse: null, evidence: "unavailable", ...(reason ? { reason } : {}) };
  }
  const rendered: RenderedFont[] = fonts.map((f) => ({
    family: f.familyName,
    postScriptName: f.postScriptName ?? "",
    glyphCount: f.glyphCount,
    isWebFont: f.isCustomFont,
  }));
  const first = firstDeclaredFamily(declared);
  // 一个字形都没渲染 = 无从判断,不是"没用上"(知乎 body 实测)
  const firstChoiceInUse = first === null || rendered.length === 0
    ? null
    : rendered.some((r) => matchesFamily(r, first));
  return { declared, rendered, firstChoiceInUse, evidence: "cdp-platform-fonts" };
}

export interface FontFaceSummary {
  family: string;
  variants: number;
  weights?: string[];
  styles?: string[];
  src: string;
  subsetted: boolean;
  display?: string;
}

export interface FontFacesResult {
  faces: FontFaceSummary[];
  totalFamilies: number;
  truncated: boolean;
}

/** 中文站常把一个字体按 unicode-range 切上百片(知乎 MiSans L3 302 条,原样返回 81KB)。 */
export function aggregateFontFaces(
  rules: Array<Record<string, string>>,
  maxFamilies = 20,
): FontFacesResult {
  const byFamily = new Map<string, Array<Record<string, string>>>();
  for (const r of rules) {
    const family = (r["font-family"] ?? "").replace(/["']/g, "").trim();
    if (family === "") continue;
    const list = byFamily.get(family);
    if (list) list.push(r);
    else byFamily.set(family, [r]);
  }

  // 变体多的排前面:截断时先留下真正承重的那个 family
  const sorted = [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length);
  const faces = sorted.slice(0, maxFamilies).map(([family, list]) => summarize(family, list));
  return { faces, totalFamilies: sorted.length, truncated: sorted.length > maxFamilies };
}

function summarize(family: string, list: Array<Record<string, string>>): FontFaceSummary {
  const uniq = (key: string): string[] =>
    [...new Set(list.map((r) => r[key]).filter((v): v is string => !!v))].sort();
  const display = list.find((r) => r["font-display"])?.["font-display"];
  const weights = uniq("font-weight");
  const styles = uniq("font-style");
  return {
    family,
    variants: list.length,
    ...(weights.length > 0 ? { weights } : {}),
    ...(styles.length > 0 ? { styles } : {}),
    src: list[0]?.src ?? "",
    subsetted: list.some((r) => !!r["unicode-range"]),
    ...(display ? { display } : {}),
  };
}
