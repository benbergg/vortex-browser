// packages/vortex-bench/src/runner/extract-assert.ts
// 缺口 J — extract 容差断言范式（纯函数，可复用基座，E/H 也用）。
//
// 设计前提（详见设计文档）：vortex_extract 是确定性文本/值提取，不是 LLM 结构化。
// 故标准锚"从正确目标取到的文本是否包含 ground-truth 事实"，而非"返回正确 typed array"。
// 容差机制借鉴 Stagehand extract eval：Jaro-Winkler（字符串相似度，抗格式噪声）、
// 数值容差带（抗真站数值漂移如 github stars）、completeness（N 行表关键值是否取全）。

/**
 * 规范化：trim + 折叠内部空白 + lowercase。
 * 与 judge-match.normalizeLabel 同口径；两处逻辑应保持一致（未来可合并单一真源）。
 */
export function normalizeString(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 规范化后精确相等 */
export function exactMatch(actual: string, expected: string): boolean {
  return normalizeString(actual) === normalizeString(expected);
}

/**
 * Jaro 相似度 ∈ [0,1]。大小写敏感（fuzzyMatch 会先规范化再调用）。
 * 标准算法：匹配窗口 = floor(max(len)/2)-1，计 matches 与 transpositions。
 */
function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1Matches = new Array<boolean>(len1).fill(false);
  const s2Matches = new Array<boolean>(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // transpositions：匹配字符顺序错位数 / 2
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;
}

/**
 * Jaro-Winkler 相似度 ∈ [0,1]：在 Jaro 基础上对公共前缀（≤4 字符）加权。
 * 维基标准值：MARTHA/MARHTA≈0.961、DWAYNE/DUANE≈0.84、DIXON/DICKSONX≈0.813。
 */
export function jaroWinkler(s1: string, s2: string): number {
  const j = jaro(s1, s2);
  if (j === 1) return 1; // 含两空串 / 完全相同
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  let prefix = 0;
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

/** 规范化后做 Jaro-Winkler，≥ 阈值即匹配（默认 0.9，Stagehand 用 0.85–0.90）。 */
export function fuzzyMatch(actual: string, expected: string, threshold = 0.9): boolean {
  return jaroWinkler(normalizeString(actual), normalizeString(expected)) >= threshold;
}

/**
 * 从文本抽第一个数字，支持千分位逗号、k/m 后缀（×1e3 / ×1e6）、前置货币符。
 * 抽不出数字返回 null（调用方据此判 false，绝不静默当 0）。
 */
function parseLeadingNumber(text: string): number | null {
  const m = text.match(/(\d[\d,]*(?:\.\d+)?)\s*([km])?/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  const suffix = m[2]?.toLowerCase();
  if (suffix === "k") return n * 1000;
  if (suffix === "m") return n * 1_000_000;
  return n;
}

/** 数值容差：抽 text 第一个数字，落 [expected-band, expected+band] 即 true。无数字 → false。 */
export function numericWithinBand(text: string, expected: number, band: number): boolean {
  const n = parseLeadingNumber(text);
  if (n === null) return false;
  return Math.abs(n - expected) <= band;
}

/**
 * 完整性：actualText 规范化后是否包含全部 expectedValues（逐个 substring 判定）。
 * 用于 N 行表"关键值是否取全"——符合 vortex extract 真实职责（取全文本，结构化交给调用方）。
 */
export function containsAll(
  actualText: string,
  expectedValues: string[],
): { ok: boolean; missing: string[] } {
  const hay = normalizeString(actualText);
  const missing = expectedValues.filter((v) => !hay.includes(normalizeString(v)));
  return { ok: missing.length === 0, missing };
}

/** 负向：actualText 规范化后不应包含 forbidden（target 之外的值不该被取到）。 */
export function notContains(actualText: string, forbidden: string): boolean {
  return !normalizeString(actualText).includes(normalizeString(forbidden));
}
