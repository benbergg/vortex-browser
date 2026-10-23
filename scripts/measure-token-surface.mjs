#!/usr/bin/env node
/**
 * Token 成本结构化估算（Vortex MCP 工具面 + bench 输出体量）
 *
 * 口径（结构化估算，**非精确 tokenizer**）：
 *   - 中文/全角字符（码位 > 0x2E80）按 1 字 1 token 计；
 *   - 其余 ASCII 字符按 4 字符 1 token 计，向上取整。
 *   ⇒ 用于**体积闸门与前后对比**，不等同于真实模型的分词结果。
 *   （与 packages/mcp/src/contract.ts 的 estimateTokens 同口径，两边可对照。）
 *
 * 数据来源：
 *   - 工具面：packages/mcp/dist/src/tools/schemas-public.js（缺失时回退 src/*.ts 源文件）
 *   - bench：packages/vortex-bench/reports/baseline.json（可用 --report 覆盖）
 *
 * 用法：
 *   node scripts/measure-token-surface.mjs                        # 打印报告
 *   node scripts/measure-token-surface.mjs --json                 # 机器可读
 *   node scripts/measure-token-surface.mjs --report <path>        # 换 bench 报告
 *   node scripts/measure-token-surface.mjs --compare <path>       # 与另一份报告前后对比
 *   VORTEX_REPO=/path/to/vortex node scripts/measure-token-surface.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：优先环境变量，否则取本脚本所在 scripts/ 的上一级。 */
const VORTEX = process.env.VORTEX_REPO ?? resolve(HERE, "..");
const BENCH = join(VORTEX, "packages/vortex-bench");
const DEFAULT_REPORT = join(BENCH, "reports/baseline.json");

/**
 * A10/A11 验收阈值（= 既有 baseline 的实测值，"不劣化"即不高于这三个数）。
 * 三项均为**越小越好**。
 */
const ACCEPTANCE = {
  avgCalls: { max: 9.0, label: "平均调用次数 callCount" },
  avgOutputBytes: { max: 3592, label: "平均输出体量 outputBytes" },
  debugReadShare: { max: 35.5, label: "vortex_debug_read 输出占比 %" },
};

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const flagValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const resolveArgPath = (p) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/** 终端显示宽度：中文/全角按 2 列（与 token 口径的宽字符判定保持一致）。 */
function displayWidth(text) {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}
const padEndWide = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)));
const padStartWide = (text, width) => " ".repeat(Math.max(0, width - displayWidth(text))) + text;

/**
 * 结构化 token 估算：**不是精确 tokenizer**。
 * 中文/全角 1 字 1 token，其余 ASCII 4 字符 1 token，向上取整。
 */
export function estimateTokens(text) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x2e80) cjk += 1; // 中文/全角/CJK 标点等
    else ascii += 1;
  }
  return { tokens: cjk + Math.ceil(ascii / 4), cjk, ascii };
}

/**
 * 读一个 JS 字符串字面量（支持 " ' ` 与常见转义），返回 { value, end }；不是字面量则 null。
 */
function readStringLiteral(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let i = start + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1] ?? "";
      value +=
        next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next === "b" ? "\b" : next === "f" ? "\f" : next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return null;
}

/**
 * 取工具块的 description 正文。
 * 编译产物里长 description 常被 TS 拆成 `"..." + "..."` 拼接，
 * 只匹配第一个字面量会**少算 token**，故这里按拼接链完整读取。
 */
function extractDescription(chunk) {
  const at = /description\s*:/.exec(chunk);
  if (!at) return "";
  let i = at.index + at[0].length;
  const skipSpace = () => {
    while (i < chunk.length && /\s/.test(chunk[i])) i += 1;
  };
  skipSpace();
  let out = "";
  for (;;) {
    const lit = readStringLiteral(chunk, i);
    if (!lit) break;
    out += lit.value;
    i = lit.end;
    skipSpace();
    if (chunk[i] === "+") {
      i += 1;
      skipSpace();
      continue;
    }
    break;
  }
  return out;
}

/** 工具面：description 体量（运行时真正进上下文的部分）。 */
function toolSurface() {
  const dist = join(VORTEX, "packages/mcp/dist/src/tools/schemas-public.js");
  const src = join(VORTEX, "packages/mcp/src/tools/schemas-public.ts");
  const file = existsSync(dist) ? dist : src;
  if (!existsSync(file)) {
    throw new Error(
      `找不到工具面定义：${dist}（或 ${src}）\n` +
        "  修复：pnpm -C packages/mcp build（构建产物缺失时会回退到 TS 源文件）",
    );
  }
  const text = readFileSync(file, "utf8");

  // 逐工具切块：以"下一个工具名"为块边界，避免 description 从后一个工具里漏取。
  const heads = [...text.matchAll(/name:\s*"(vortex_[a-z_]+)"/g)].map((m) => ({
    name: m[1],
    index: m.index ?? 0,
  }));

  const tools = heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const chunk = text.slice(head.index, end);
    const desc = extractDescription(chunk);
    return {
      name: head.name,
      descTokens: estimateTokens(desc).tokens,
      descChars: desc.length,
    };
  });

  const fileTokens = estimateTokens(text).tokens;
  return { tools, fileTokens, fileChars: text.length, file };
}

/** bench 报告聚合：调用次数 / 输出体量 / 按工具的输出占比。 */
function benchReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  const d = JSON.parse(readFileSync(reportPath, "utf8"));
  const cases = d.cases ?? [];
  let calls = 0;
  let bytes = 0;
  let dur = 0;
  const byTool = new Map();
  for (const c of cases) {
    calls += c.callCount ?? 0;
    bytes += c.outputBytes ?? 0;
    dur += c.durationMs ?? 0;
    for (const [k, v] of Object.entries(c.outputBytesByTool ?? {})) {
      byTool.set(k, (byTool.get(k) ?? 0) + v);
    }
  }
  const n = cases.length || 1;
  const toolBytes = [...byTool.values()].reduce((a, b) => a + b, 0);
  const debugReadBytes = byTool.get("vortex_debug_read") ?? 0;
  return {
    source: reportPath,
    generatedAt: d.generatedAt,
    cases: n,
    totalCalls: calls,
    avgCalls: +(calls / n).toFixed(2),
    totalOutputBytes: bytes,
    avgOutputBytes: Math.round(bytes / n),
    totalOutputTokens: Math.ceil(bytes / 4),
    avgOutputTokens: Math.ceil(bytes / n / 4),
    avgDurationMs: Math.round(dur / n),
    toolBytesTotal: toolBytes,
    debugReadShare: toolBytes > 0 ? +((debugReadBytes / toolBytes) * 100).toFixed(2) : 0,
    byTool: [...byTool.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tool, b]) => ({
        tool,
        bytes: b,
        share: toolBytes > 0 ? +((b / toolBytes) * 100).toFixed(2) : 0,
      })),
  };
}

/** 前后对比：A10/A11 三组数字 vs 阈值。 */
function compare(primary, secondary) {
  const rows = [
    {
      key: "avgCalls",
      ...ACCEPTANCE.avgCalls,
      primary: primary.avgCalls,
      secondary: secondary.avgCalls,
      unit: "",
      pass: secondary.avgCalls <= ACCEPTANCE.avgCalls.max,
    },
    {
      key: "avgOutputBytes",
      ...ACCEPTANCE.avgOutputBytes,
      primary: primary.avgOutputBytes,
      secondary: secondary.avgOutputBytes,
      unit: "B",
      pass: secondary.avgOutputBytes <= ACCEPTANCE.avgOutputBytes.max,
    },
    {
      key: "debugReadShare",
      ...ACCEPTANCE.debugReadShare,
      primary: primary.debugReadShare,
      secondary: secondary.debugReadShare,
      unit: "%",
      pass: secondary.debugReadShare <= ACCEPTANCE.debugReadShare.max,
    },
  ];
  return { rows, pass: rows.every((r) => r.pass) };
}

const surface = toolSurface();
const primary = benchReport(flagValue("--report") ? resolveArgPath(flagValue("--report")) : DEFAULT_REPORT);
const compareTo = flagValue("--compare") ? benchReport(resolveArgPath(flagValue("--compare"))) : null;
const verdict = primary && compareTo ? compare(primary, compareTo) : null;

const report = { surface, bench: primary, compare: compareTo, verdict };

if (hasFlag("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("=== Vortex MCP 工具面（常驻 token）");
  console.log(`来源: ${surface.file}`);
  console.log(`工具数: ${surface.tools.length}`);
  console.log(
    `schema 源文件: ${surface.fileChars} 字符 ≈ ${surface.fileTokens} tokens（构建产物，> 运行时真实注入量）`,
  );
  const descSum = surface.tools.reduce((a, t) => a + t.descTokens, 0);
  console.log(`description 合计 ≈ ${descSum} tokens`);
  console.log("--- 每个工具的 description 体量（运行时真正进上下文的部分）");
  for (const t of [...surface.tools].sort((a, b) => b.descTokens - a.descTokens)) {
    console.log(`  ${t.name.padEnd(22)} ${String(t.descTokens).padStart(5)} tokens`);
  }

  if (primary) {
    console.log("\n=== bench 基线（每任务增量 token / 效率）");
    console.log(`来源: ${primary.source}`);
    console.log(`生成于 ${primary.generatedAt}，${primary.cases} 个 case`);
    console.log(
      `平均调用 ${primary.avgCalls} 次/任务，平均输出 ${primary.avgOutputBytes} 字节 ≈ ${primary.avgOutputTokens} tokens/任务`,
    );
    console.log(`总输出 ${primary.totalOutputBytes} 字节 ≈ ${primary.totalOutputTokens} tokens`);
    console.log(`平均耗时 ${primary.avgDurationMs} ms/任务`);
    console.log("--- 输出字节占比（top）");
    for (const t of primary.byTool.slice(0, 8)) {
      console.log(
        `  ${t.tool.padEnd(22)} ${String(t.bytes).padStart(7)} B  ${String(t.share).padStart(6)}%`,
      );
    }
  } else {
    console.log("\n=== bench 基线：未找到报告文件（跳过）");
  }

  if (compareTo && verdict) {
    console.log("\n=== 前后对比（A10/A11 三组数字，越小越好）");
    console.log(
      `  ${padEndWide("指标", 30)} ${padStartWide("baseline", 10)} ${padStartWide("new", 10)} ${padStartWide("阈值", 10)}  判定`,
    );
    for (const r of verdict.rows) {
      const fmt = (v) => `${v}${r.unit}`;
      const threshold = `≤${r.max % 1 === 0 ? r.max.toFixed(1) : r.max}${r.unit}`;
      console.log(
        `  ${padEndWide(r.label, 30)} ${padStartWide(fmt(r.primary), 10)} ${padStartWide(fmt(r.secondary), 10)} ${padStartWide(threshold, 10)}  ${r.pass ? "PASS" : "FAIL"}`,
      );
    }
    console.log(`  结论: ${verdict.pass ? "PASS（无劣化）" : "FAIL（有劣化）"}`);
  }
}
