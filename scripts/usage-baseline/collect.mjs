#!/usr/bin/env node
// 使用基线快照(多源)。
//
// 为什么需要它:修复上线时若不留当时的指标,"改进了"只是叙事。transcript 只有滚动窗口,
// 过期即不可复现。本脚本把当下的可比指标钉在磁盘上。
//
// 窗口会滚动,所以任何跨期比较都必须先对齐窗口:用 --days 取"最近 N 天",
// 跨期比较时用 --from/--to 固定两端(两期必须用同一个抽取器、同一套口径重跑)。
//
// 三个数据源:Claude Code transcript / Pi 会话 / Codex rollout。
// Codex 的 MCP 调用被包在 codemode 的 exec 文本里,没有结构化配对,
// 只作辅助证据(scanCodexFile),不进主分母,覆盖率单独标注。
//
// 用法:
//   node scripts/usage-baseline/collect.mjs --label week-2026-10-30 --days 7
//   node scripts/usage-baseline/collect.mjs --label prev-week --from 2026-10-16T00:00:00 --to 2026-10-23T00:00:00
//   node scripts/usage-baseline/collect.mjs --compare <旧.json> <新.json>

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseClaudeFile,
  parsePiFile,
  parseCodexFile,
  parseSinkFile,
  buildFacts,
  reduceFacts,
  errorSignature,
  isEmptySuccess,
  resultText,
} from "./extract.mjs";

const HOME = homedir();
const OUT_DIR = join("reports", "_eval", "baseline");

const SOURCES = {
  claude: { dir: join(HOME, ".claude", "projects") },
  pi: { dir: join(HOME, ".pi", "agent", "sessions") },
  codex: { dir: join(HOME, ".codex", "sessions") },
  sink: { dir: join(HOME, ".vortex", "logs") },
};

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".jsonl")) yield p;
  }
}

// Bash 里直接跑 playwright / puppeteer 也是选了 playwright。只数 mcp__playwright__*
// 会把占比算成下界——历史上 MCP 967 次之外还有 Bash 121 次。
function browserRoute(name, input) {
  if (name.startsWith("mcp__vortex__")) return "vortex";
  if (name.startsWith("mcp__playwright__")) return "playwright";
  if (name === "Bash" && /playwright|puppeteer/i.test(String(input?.command ?? ""))) return "playwright";
  return null;
}

function collect({ days, from, to, sources }) {
  const now = Date.now();
  const toTs = to ? Date.parse(to) : now;
  const fromTs = from ? Date.parse(from) : days ? now - days * 86400_000 : 0;
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) throw new Error("窗口非法:--from/--to 必须是 ISO 时间");

  const events = [];
  const coverage = {
    window: { from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString() },
    perSource: {},
    codexAux: null,
  };
  const routeCounts = { vortex: 0, playwright: 0 };
  let minTs = Infinity;
  let maxTs = 0;

  // 文件级预筛只能按 mtime >= from 排：**不能用 mtime <= to**。
  // 会话文件是持续追加的，窗口内还在写的会话在窗口结束后 mtime 会大于 to，
  // 按上界筛会把「窗口内有调用、但会话延续到窗口后」的会话整份漏掉（少样本）。
  // 事件级再按 ts ∈ [from,to] 过滤，才是真正的窗口口径。
  const fileMayContainWindow = (st) => st.mtimeMs >= fromTs;

  for (const src of sources) {
    const def = SOURCES[src];
    const cov = { filesScanned: 0, filesWithVortex: 0, filesUnreadable: 0, calls: 0, results: 0 };
    for (const file of walk(def.dir)) {
      let raw;
      try {
        const st = statSync(file);
        if (!fileMayContainWindow(st)) continue;
        raw = readFileSync(file, "utf8");
      } catch {
        cov.filesUnreadable++;
        continue;
      }
      cov.filesScanned++;

      if (src === "claude") {
        const parsed = parseClaudeFile(raw, file);
        events.push(parsed);
        cov.calls += parsed.calls.length;
        cov.results += parsed.results.length;
        if (parsed.calls.length) cov.filesWithVortex++;
        // 浏览器工具份额(同源对比用)
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let d;
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          const ts = Date.parse(d.timestamp ?? "");
          if (!Number.isFinite(ts) || ts < fromTs || ts >= toTs) continue;
          const content = d.message?.content;
          if (!Array.isArray(content)) continue;
          for (const b of content) {
            if (b?.type === "tool_use") {
              const route = browserRoute(b.name, b.input);
              if (route) routeCounts[route]++;
            }
          }
        }
      } else if (src === "pi") {
        const parsed = parsePiFile(raw, file);
        events.push(parsed);
        cov.calls += parsed.calls.length;
        cov.results += parsed.results.length;
        if (parsed.calls.length) cov.filesWithVortex++;
      } else if (src === "codex") {
        const scan = parseCodexFile(raw, fromTs, toTs);
        const c = [...scan.calls.values()].reduce((s, n) => s + n, 0);
        if (c) {
          cov.filesWithVortex++;
          cov.calls += c;
        }
      } else if (src === "sink") {
        const parsed = parseSinkFile(raw, file);
        events.push(parsed);
        cov.calls += parsed.calls.length;
        cov.results += parsed.results.length;
        if (parsed.calls.length) cov.filesWithVortex++;
      }
    }
    coverage.perSource[src] = cov;
  }

  // Codex:文本级辅助证据,单列(只有"发起调用的 exec 脚本"里的调用形态算数)
  if (sources.includes("codex")) {
    const aux = { calls: 0, perTool: {} };
    for (const file of walk(SOURCES.codex.dir)) {
      let raw;
      try {
        const st = statSync(file);
        if (!fileMayContainWindow(st)) continue;
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const scan = parseCodexFile(raw, fromTs, toTs);
      for (const [t, n] of scan.calls) {
        aux.perTool[t] = (aux.perTool[t] ?? 0) + n;
        aux.calls += n;
      }
    }
    coverage.codexAux = aux;
  }

  const facts = buildFacts(events);
  const inWindow = facts.filter((f) => f.ts >= fromTs && f.ts < toTs);
  for (const f of inWindow) {
    minTs = Math.min(minTs, f.ts);
    maxTs = Math.max(maxTs, f.ts);
  }

  // 覆盖表里的「调用/结果」按**窗口内事件**重算：文件级解析量会把窗口外的
  // 事件算进来（前一周的 pi 就出现过文件里有 103 次调用但窗口内 0 次）。
  for (const cov of Object.values(coverage.perSource)) {
    cov.calls = 0;
    cov.results = 0;
  }
  for (const f of inWindow) {
    const cov = coverage.perSource[f.src];
    if (!cov) continue;
    cov.calls += 1;
    if (f.outcome !== "unpaired" && f.outcome !== "unknown") cov.results += 1;
  }

  const snapshot = reduceFacts(inWindow, {
    window: {
      from: new Date(fromTs).toISOString(),
      to: new Date(toTs).toISOString(),
      observedFrom: Number.isFinite(minTs) ? new Date(minTs).toISOString() : null,
      observedTo: maxTs ? new Date(maxTs).toISOString() : null,
      activeDays: new Set(inWindow.map((f) => new Date(f.ts).toISOString().slice(0, 10))).size,
    },
    coverage,
  });

  snapshot.routes = {
    ...routeCounts,
    vortexShare:
      routeCounts.vortex + routeCounts.playwright
        ? +(routeCounts.vortex / (routeCounts.vortex + routeCounts.playwright)).toFixed(4)
        : null,
  };
  snapshot.label = null;
  return snapshot;
}

const MIN_CALLS_FOR_RATE = 20; // 样本太小的错误率是噪声,不进主表
const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
/** 窗口同时给本地时间与 UTC：机器时区 CST(UTC+8)，只看 UTC 会看错一天。 */
const localTime = (iso) =>
  iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: undefined }).replace("T", " ").slice(0, 16) : "—";

function toMarkdown(snap, label) {
  const w = snap.window;
  const rows = snap.perTool
    .filter((r) => r.calls >= MIN_CALLS_FOR_RATE)
    .map(
      (r) =>
        `| ${r.tool} | ${r.calls} | ${r.ok} | ${r.errors} | ${pct(r.errorRate)} | ${r.emptySuccess} | ${pct(r.emptyRate)} | ${r.unpaired} | ${r.unknown} |`,
    )
    .join("\n");
  const srcRows = snap.perSource
    .map((r) => `| ${r.src} | ${r.calls} | ${r.ok} | ${r.errors} | ${pct(r.errorRate)} | ${r.emptySuccess} | ${r.unpaired} | ${r.unknown} |`)
    .join("\n");
  const errs = snap.topErrors
    .slice(0, 20)
    .map((e) => `| ${e.count} | \`${e.sig.replace(/\|/g, "\\|")}\` |`)
    .join("\n");
  const cov = snap.coverage;
  const covRows = Object.entries(cov.perSource)
    .map(([src, c]) => `| ${src} | ${c.filesScanned} | ${c.filesWithVortex} | ${c.filesUnreadable} | ${c.calls} | ${c.results} |`)
    .join("\n");
  const sessRows = snap.perSession
    .slice(0, 10)
    .map((r) => `| ${String(r.session).slice(-46)} | ${r.calls} | ${r.errors} | ${pct(r.errorRate)} |`)
    .join("\n");
  return `# vortex 使用基线 — ${label}

窗口 ${localTime(w.from)} → ${localTime(w.to)}（本地时间；UTC ${w.from.slice(11, 16)} → ${w.to.slice(11, 16)}）
实际观测 ${localTime(w.observedFrom)} → ${localTime(w.observedTo)}，活跃 ${w.activeDays} 天

- 总调用 ${snap.totals.calls}：ok ${snap.totals.ok} / error ${snap.totals.errors} / unpaired ${snap.totals.unpaired} / unknown ${snap.totals.unknown}
- 错误率 ${pct(snap.totals.errorRate)}（分母 = 配对成功 ${snap.totals.settled}；unknown 与 unpaired 不计入）
- 成功但空返回 ${pct(snap.totals.emptyRate)}（${snap.totals.emptySuccess} 次，isError 看不见这一类）
- unknown 占比 ${pct(snap.totals.unknownRate)}，unpaired 占比 ${pct(snap.totals.unpairedRate)}
- 错误后下一次调用（**会话内**排序，${snap.recovery.sessions} 个会话）：成功 ${snap.recovery.nextOk} / 再错 ${snap.recovery.nextError} / 其他 ${snap.recovery.nextOther}
- 成本代理：入参 ${snap.cost.argsChars} 字符 / 返回 ${snap.cost.resultChars} 字符；耗时中位 ${snap.cost.medianDurationMs ?? "—"}ms，P95 ${snap.cost.p95DurationMs ?? "—"}ms（${snap.cost.durationSamples} 个样本）

## 各源覆盖

| 源 | 扫过的文件 | 含 vortex 调用的文件 | 读失败 | 调用 | 结果 |
|---|---:|---:|---:|---:|---:|
${covRows}

Codex 辅助证据（exec 脚本里的调用形态，不进主分母）：${cov.codexAux ? `调用 ${cov.codexAux.calls} 次` : "无"}

## 按源

| 源 | 调用 | ok | 错误 | 错误率 | 空返回 | unpaired | unknown |
|---|---:|---:|---:|---:|---:|---:|---:|
${srcRows}

## 各工具（调用数 ≥ ${MIN_CALLS_FOR_RATE}）

| 工具 | 调用 | ok | 错误 | 错误率 | 空返回 | 空返回率 | unpaired | unknown |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

## 会话 Top10（样本偏斜看这里）

| 会话 | 调用 | 错误 | 错误率 |
|---|---:|---:|---:|
${sessRows}

## Top 错误签名

| 次数 | 归一化签名 |
|---:|---|
${errs}

原始数据同名 \`.json\`，跨期对比用 \`--compare 旧.json 新.json\`。
`;
}

function compare(pathA, pathB) {
  const A = JSON.parse(readFileSync(pathA, "utf8"));
  const B = JSON.parse(readFileSync(pathB, "utf8"));
  const sameWindow =
    A.window?.from === B.window?.from && A.window?.to === B.window?.to;
  const warn = sameWindow
    ? ""
    : `\n> ⚠️ 两次快照窗口不同（${A.window?.from} → ${A.window?.to} vs ${B.window?.from} → ${B.window?.to}），绝对值不可比。\n`;
  const mapA = new Map(A.perTool.map((r) => [r.tool, r]));
  const lines = B.perTool
    .filter((r) => r.calls >= MIN_CALLS_FOR_RATE)
    .map((r) => {
      const a = mapA.get(r.tool);
      const d = a && a.errorRate != null && r.errorRate != null ? r.errorRate - a.errorRate : null;
      const arrow = d == null ? "新" : d < -0.01 ? "↓ 改善" : d > 0.01 ? "↑ 恶化" : "≈";
      return `| ${r.tool} | ${a ? pct(a.errorRate) : "—"} | ${pct(r.errorRate)} | ${arrow} |`;
    })
    .join("\n");
  const totA = A.totals?.errorRate ?? A.totals?.errors;
  const totB = B.totals?.errorRate ?? B.totals?.errors;
  return `# 基线对比\n\nA ${A.window?.from?.slice(0, 10)}→${A.window?.to?.slice(0, 10)}　B ${B.window?.from?.slice(0, 10)}→${B.window?.to?.slice(0, 10)}\n${warn}
| 工具 | A 错误率 | B 错误率 | 变化 |
|---|---:|---:|---|
${lines}

总错误率 ${pct(A.totals?.errorRate)} → ${pct(B.totals?.errorRate)}　空返回率 ${pct(A.totals?.emptyRate)} → ${pct(B.totals?.emptyRate)}
`;
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const cmp = argv.indexOf("--compare");
  if (cmp >= 0) {
    console.log(compare(argv[cmp + 1], argv[cmp + 2]));
    return;
  }

  const label = get("--label") ?? "baseline";
  const days = get("--days") ? Number(get("--days")) : undefined;
  const from = get("--from");
  const to = get("--to");
  const sources = (get("--sources") ?? "claude,pi,codex").split(",").map((s) => s.trim()).filter(Boolean);
  const snap = collect({ days, from, to, sources });
  snap.label = label;

  const outDir = get("--out") ?? OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = join(outDir, `${stamp}-${label}`);
  writeFileSync(`${base}.json`, JSON.stringify(snap, null, 2));
  const md = toMarkdown(snap, label);
  writeFileSync(`${base}.md`, md);
  console.log(md);
  console.log(`\n已写入 ${base}.json / ${base}.md`);
}

main();
