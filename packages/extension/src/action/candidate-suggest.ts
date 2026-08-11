// packages/extension/src/action/candidate-suggest.ts
//
// 选择器零命中时的候选建议(纯函数,host 侧执行)。页面侧只负责采名字,排序与文案在此,
// 避开 executeScript func 注入丢模块作用域的坑(见 heal.ts 的 __healInlineBody 内联范式)。
//
// 与 matchByDescriptor 的分工:那边要精确(命中即触发动作,错配代价高);这边可宽松
// (只给人/LLM 读)。故此处剥掉全部空白而非仅折叠——日志里 `取 消` 要能建议到 `取消`。

/** 建议专用归一化:小写 + 剥掉全部空白(比 normName 的折叠更激进,理由见文件头)。 */
function loose(s: string): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, "");
}

function bigrams(s: string): string[] {
  if (s.length < 2) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice(字符 bigram)。对中英文都可用,不依赖分词。 */
function dice(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const pool = new Map<string, number>();
  for (const g of A) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of B) {
    const n = pool.get(g) ?? 0;
    if (n > 0) { hit++; pool.set(g, n - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

/**
 * target 与候选 name 的相近度 [0,1]。
 * 剥空白后相同 → 1;一方包含另一方 → 加权提升;否则字符 bigram Dice。
 */
export function scoreNameSimilarity(target: string, name: string): number {
  const t = loose(target), n = loose(name);
  if (!t || !n) return 0;
  if (t === n) return 1;
  const base = dice(t, n);
  // 包含关系是强信号:`查询按钮`⊃`查询`、英文长描述⊃`close`。
  const contains = t.includes(n) || n.includes(t);
  return contains ? Math.min(1, base + 0.3) : base;
}

export interface NameCandidate {
  name: string;
  tag: string;
}
export interface RankedCandidate extends NameCandidate {
  score: number;
}

// 低于此分视为无关。宁可返回空也不塞噪声——target 是真 CSS 选择器时
// 按名字排出来的候选只会误导(日志样本 `.card-wrapper.card-expanded[id]`)。
const MIN_SCORE = 0.2;

export function rankCandidates(
  candidates: NameCandidate[],
  target: string,
  limit: number,
): RankedCandidate[] {
  return candidates
    .map((c) => ({ ...c, score: scoreNameSimilarity(target, c.name) }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

/**
 * 零命中的错误正文。刻意不提"调大 timeout"——日志实测同 target 重试成功 0 次,
 * 那条建议把 agent 引向死路(它随后普遍逃向 vortex_evaluate 手写匹配)。
 */
export function buildNoMatchMessage(target: string, ranked: RankedCandidate[]): string {
  const head =
    `target ${JSON.stringify(target)} matched no element ` +
    `(not an @ref, so it was used as a CSS selector).`;
  if (!ranked.length) {
    return `${head} No element with a similar accessible name was found either. ` +
      `Call vortex_observe to list what is actually on the page, then act with its @ref.`;
  }
  const list = ranked.map((c) => `${JSON.stringify(c.name)} (${c.tag})`).join(", ");
  return `${head} Nearest by accessible name: ${list}. ` +
    `Call vortex_observe to get an @ref for the intended one, or pass a valid CSS selector.`;
}
