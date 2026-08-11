#!/usr/bin/env node
// 使用基线快照。
//
// 为什么需要它:修复上线时若不留当时的指标,"改进了"就只是叙事。act 20.4% 的错误率
// 是某次修复之前的数字,现在多少?答不了——没存改前快照,而 transcript 只有 ~29 天的
// 滚动窗口,过期即不可复现。本脚本把当下的可比指标钉在磁盘上。
//
// 窗口会滚动,所以任何跨期比较都必须先对齐窗口:用 --days 取"最近 N 天"而不是全量,
// 否则两次快照的分母根本不是一回事。
//
// 用法:
//   node scripts/usage-baseline/collect.mjs --label post-timeout-ladder --days 14
//   node scripts/usage-baseline/collect.mjs --compare <旧.json> <新.json>

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const OUT_DIR = join("reports", "_eval", "baseline");
const MIN_CALLS_FOR_RATE = 20; // 样本太小的错误率是噪声,不进主表

// ── 错误签名归一化 ──
// 不归一化就没法跨期聚合:同一类错误每次带着不同的 id / 尺寸 / 选择器,
// 会散成几十个只出现一次的串,看上去像"没有主要矛盾"。
function errorSignature(text) {
  return String(text)
    .slice(0, 400)
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/@[0-9a-f]{4,}:e\d+/gi, "<ref>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// 成功但没内容。isError 看不见这一类:调用返回 200、结构合法、载荷为空。
// 实测 query 有三成落在这里,在只看错误率的视角下完全隐形。
const EMPTY_PATTERNS = [
  /^\s*(\[\]|\{\}|""|null|undefined)\s*$/,
  /"(items|rows|matches|elements|results|records|data|tabs)"\s*:\s*\[\s*\]/,
  /\btotal"?\s*:\s*0\b/,
  /^\s*No .{0,40}(found|match)/i,
];
// 非文本载荷(截图的 image block)不能按文本判空,否则 screenshot 会 94% 显示"空返回"。
function hasNonTextPayload(content) {
  return Array.isArray(content) && content.some((c) => c && typeof c === "object" && c.type !== "text");
}

function isEmptySuccess(content) {
  if (hasNonTextPayload(content)) return false;
  const t = resultText(content).trim();
  if (!t) return true;
  if (t.length > 4000) return false; // 大响应不可能是空
  return EMPTY_PATTERNS.some((re) => re.test(t));
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c && typeof c === "object" && c.type === "text" ? c.text : ""))
      .join("\n");
  }
  return "";
}

function* walkTranscripts(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTranscripts(p);
    else if (entry.name.endsWith(".jsonl")) yield p;
  }
}

// Bash 里直接跑 playwright / puppeteer 也是选了 playwright。只数 mcp__playwright__*
// 会把占比算成下界——实测历史上 MCP 967 次之外还有 Bash 121 次。
function browserRoute(name, input) {
  if (name.startsWith("mcp__vortex__")) return "vortex";
  if (name.startsWith("mcp__playwright__")) return "playwright";
  if (name === "Bash" && /playwright|puppeteer/i.test(String(input?.command ?? ""))) return "playwright";
  return null;
}

function collect({ days }) {
  const cutoff = days ? Date.now() - days * 86400_000 : 0;
  const pendingByToolId = new Map();
  const perTool = new Map();
  const errorCounts = new Map();
  const perSession = new Map();
  const perProject = new Map();
  const routeCounts = { vortex: 0, playwright: 0 };
  const days_ = new Set();
  let files = 0;
  let minTs = Infinity;
  let maxTs = 0;

  const bump = (map, key, field) => {
    if (!map.has(key)) map.set(key, { calls: 0, errors: 0, emptySuccess: 0 });
    map.get(key)[field] += 1;
  };

  for (const file of walkTranscripts(PROJECTS_DIR)) {
    if (days && statSync(file).mtimeMs < cutoff) continue;
    files++;
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Date.parse(d.timestamp ?? "");
      if (!Number.isFinite(ts) || (cutoff && ts < cutoff)) continue;
      const content = d.message?.content;
      if (!Array.isArray(content)) continue;

      for (const b of content) {
        if (!b || typeof b !== "object") continue;

        if (b.type === "tool_use") {
          const route = browserRoute(b.name, b.input);
          if (!route) continue;
          routeCounts[route]++;
          if (route !== "vortex") continue;
          const tool = b.name.replace("mcp__vortex__vortex_", "");
          pendingByToolId.set(b.id, tool);
          bump(perTool, tool, "calls");
          bump(perSession, d.sessionId ?? "?", "calls");
          bump(perProject, d.cwd ?? "?", "calls");
          days_.add(new Date(ts).toISOString().slice(0, 10));
          minTs = Math.min(minTs, ts);
          maxTs = Math.max(maxTs, ts);
        }

        if (b.type === "tool_result") {
          const tool = pendingByToolId.get(b.tool_use_id);
          if (!tool) continue;
          pendingByToolId.delete(b.tool_use_id);
          if (b.is_error) {
            bump(perTool, tool, "errors");
            const sig = `${tool} | ${errorSignature(resultText(b.content))}`;
            errorCounts.set(sig, (errorCounts.get(sig) ?? 0) + 1);
          } else if (isEmptySuccess(b.content)) {
            bump(perTool, tool, "emptySuccess");
          }
        }
      }
    }
  }

  const toolRows = [...perTool.entries()]
    .map(([tool, v]) => ({
      tool,
      calls: v.calls,
      errors: v.errors,
      errorRate: v.calls ? +(v.errors / v.calls).toFixed(4) : 0,
      emptySuccess: v.emptySuccess,
      emptyRate: v.calls ? +(v.emptySuccess / v.calls).toFixed(4) : 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  const totalCalls = toolRows.reduce((s, r) => s + r.calls, 0);
  const totalErrors = toolRows.reduce((s, r) => s + r.errors, 0);
  const totalEmpty = toolRows.reduce((s, r) => s + r.emptySuccess, 0);

  const sessionCalls = [...perSession.values()].map((v) => v.calls).sort((a, b) => b - a);
  const share = (n) => (totalCalls ? +(sessionCalls.slice(0, n).reduce((s, c) => s + c, 0) / totalCalls).toFixed(4) : 0);

  const byName = Object.fromEntries(toolRows.map((r) => [r.tool, r.calls]));

  return {
    schema: 1,
    window: {
      from: Number.isFinite(minTs) ? new Date(minTs).toISOString() : null,
      to: maxTs ? new Date(maxTs).toISOString() : null,
      activeDays: days_.size,
      requestedDays: days ?? null,
      transcriptFiles: files,
      sessions: perSession.size,
      projects: perProject.size,
    },
    totals: {
      calls: totalCalls,
      errors: totalErrors,
      errorRate: totalCalls ? +(totalErrors / totalCalls).toFixed(4) : 0,
      emptySuccess: totalEmpty,
      emptyRate: totalCalls ? +(totalEmpty / totalCalls).toFixed(4) : 0,
    },
    // 样本偏斜:少数会话贡献大部分调用时,"整体错误率"其实是那几个会话的错误率
    skew: { top1SessionShare: share(1), top5SessionShare: share(5) },
    routes: {
      ...routeCounts,
      vortexShare: routeCounts.vortex + routeCounts.playwright
        ? +(routeCounts.vortex / (routeCounts.vortex + routeCounts.playwright)).toFixed(4)
        : null,
    },
    ratios: {
      observeToEvaluate: byName.evaluate ? +((byName.observe ?? 0) / byName.evaluate).toFixed(3) : null,
    },
    perTool: toolRows,
    topErrors: [...errorCounts.entries()]
      .map(([sig, count]) => ({ sig, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
  };
}

const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");

function toMarkdown(snap, label) {
  const w = snap.window;
  const rows = snap.perTool
    .filter((r) => r.calls >= MIN_CALLS_FOR_RATE)
    .map((r) => `| ${r.tool} | ${r.calls} | ${r.errors} | ${pct(r.errorRate)} | ${r.emptySuccess} | ${pct(r.emptyRate)} |`)
    .join("\n");
  const errs = snap.topErrors
    .slice(0, 15)
    .map((e) => `| ${e.count} | \`${e.sig.replace(/\|/g, "\\|")}\` |`)
    .join("\n");
  return `# vortex 使用基线 — ${label}

窗口 ${w.from?.slice(0, 10)} → ${w.to?.slice(0, 10)}（活跃 ${w.activeDays} 天${w.requestedDays ? `，取最近 ${w.requestedDays} 天` : "，全量"}），\
${w.sessions} 会话 / ${w.projects} 项目 / ${snap.totals.calls} 次调用

- 总错误率 ${pct(snap.totals.errorRate)}（${snap.totals.errors}/${snap.totals.calls}）
- 成功但空返回 ${pct(snap.totals.emptyRate)}（${snap.totals.emptySuccess} 次，isError 看不见这一类）
- 样本偏斜 Top1 会话 ${pct(snap.skew.top1SessionShare)} / Top5 ${pct(snap.skew.top5SessionShare)}
- 浏览器工具份额 vortex ${snap.routes.vortex} vs playwright ${snap.routes.playwright}（vortex ${pct(snap.routes.vortexShare)}）
- observe : evaluate = ${snap.ratios.observeToEvaluate ?? "—"}

## 各工具（调用数 ≥ ${MIN_CALLS_FOR_RATE}）

| 工具 | 调用 | 错误 | 错误率 | 空返回 | 空返回率 |
|---|---:|---:|---:|---:|---:|
${rows}

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
  const warn =
    A.window.requestedDays !== B.window.requestedDays
      ? `\n> ⚠️ 两次快照的窗口不同（${A.window.requestedDays} vs ${B.window.requestedDays} 天），比率可比、绝对值不可比。\n`
      : "";
  const mapA = new Map(A.perTool.map((r) => [r.tool, r]));
  const lines = B.perTool
    .filter((r) => r.calls >= MIN_CALLS_FOR_RATE)
    .map((r) => {
      const a = mapA.get(r.tool);
      const d = a ? r.errorRate - a.errorRate : null;
      const arrow = d == null ? "新" : d < -0.01 ? "↓ 改善" : d > 0.01 ? "↑ 恶化" : "≈";
      return `| ${r.tool} | ${a ? pct(a.errorRate) : "—"} | ${pct(r.errorRate)} | ${arrow} |`;
    })
    .join("\n");
  return `# 基线对比\n\nA ${A.window.from?.slice(0, 10)}→${A.window.to?.slice(0, 10)}　B ${B.window.from?.slice(0, 10)}→${B.window.to?.slice(0, 10)}\n${warn}
| 工具 | A 错误率 | B 错误率 | 变化 |
|---|---:|---:|---|
${lines}

总错误率 ${pct(A.totals.errorRate)} → ${pct(B.totals.errorRate)}　空返回率 ${pct(A.totals.emptyRate)} → ${pct(B.totals.emptyRate)}
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
  const snap = collect({ days });
  snap.label = label;

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = join(OUT_DIR, `${stamp}-${label}`);
  writeFileSync(`${base}.json`, JSON.stringify(snap, null, 2));
  const md = toMarkdown(snap, label);
  writeFileSync(`${base}.md`, md);
  console.log(md);
  console.log(`\n已写入 ${base}.json / ${base}.md`);
}

main();
