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
 *
 * 固定比较集合（重要）：
 *   A10/A11 只在 **baseline.json 的 case 名称集合** 上计算 ——
 *   - suite B 的 case 不参与（自包含失败路径用例，量纲不同）；
 *   - 报告缺 case / 有重复 case / 混入集合外的 case ⇒ 明确报错并**非零退出**，
 *     不静默跳过（跳过等于让回归被稀释掉）。
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
export function benchReport(reportPath, { baselineNames } = {}) {
  if (!existsSync(reportPath)) return null;
  const d = JSON.parse(readFileSync(reportPath, "utf8"));
  const rawCases = d.cases ?? [];
  // 比较集合以基线固定名称集合为准：suite B 的 case 不参与 A10/A11，
  // 缺失 / 重复 / 混入非比较项一律报错拒绝比较（不静默跳过）。
  const picked = baselineNames
    ? selectComparableCases(rawCases, baselineNames)
    : { cases: rawCases.filter((c) => !isSuiteB(c)), suiteBCases: rawCases.filter(isSuiteB).length };
  const cases = picked.cases;
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
    suiteBCases: picked.suiteBCases,
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

/**
 * 取 case 名称（bench 报告里字段名是 `case`，兼容 `name`）。
 */
export function caseName(c) {
  if (!c || typeof c !== "object") return undefined;
  const raw = typeof c.case === "string" ? c.case : typeof c.name === "string" ? c.name : undefined;
  return raw && raw.length > 0 ? raw : undefined;
}

/** suite B 的 case（自包含失败路径用例）不参与 A10/A11 的体量计算。 */
export function isSuiteB(c) {
  return Boolean(c && typeof c === "object" && c.suite === "b");
}

/**
 * 固定比较集合：baseline.json 的 case 名称集合。
 *
 * 这是比较的**唯一**依据 —— A10/A11 只在这个集合上算，
 * 报告里多一个少一个都不作数（否则回归会被稀释掉）。
 */
export function baselineCaseNames(reportPath = DEFAULT_REPORT) {
  if (!existsSync(reportPath)) {
    throw new Error(`找不到基线报告：${reportPath}`);
  }
  const d = JSON.parse(readFileSync(reportPath, "utf8"));
  const names = [];
  for (const c of d.cases ?? []) {
    const name = caseName(c);
    if (!name) {
      throw new Error(`基线报告里有 case 缺名称：${reportPath}`);
    }
    names.push(name);
  }
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dup.length > 0) {
    throw new Error(`基线报告里有重复 case 名：${dup.join(", ")}（${reportPath}）`);
  }
  return names;
}

/**
 * 按基线固定名称集合挑出可比较的 case，并校验集合完整性。
 *
 * - suite B 的 case 直接剔除（不参与 A10/A11，也不算「混入非比较项」）；
 * - 缺失 / 重复 / 混入非集合项 ⇒ 抛错，**拒绝比较**（调用方非零退出）。
 *   绝不静默跳过 —— 跳过等于让回归被稀释掉。
 */
export function selectComparableCases(rawCases, baselineNames) {
  const allowed = new Set(baselineNames);
  const suiteA = [];
  let suiteBCases = 0;
  for (const c of rawCases ?? []) {
    if (isSuiteB(c)) {
      suiteBCases += 1;
      continue;
    }
    const name = caseName(c);
    if (!name) {
      throw new Error("报告里有 case 缺名称（case / name 字段都没有）");
    }
    suiteA.push({ name, case: c });
  }

  const seen = new Set();
  const duplicates = [];
  for (const { name } of suiteA) {
    if (seen.has(name)) duplicates.push(name);
    else seen.add(name);
  }
  const missing = baselineNames.filter((n) => !seen.has(n));
  const extra = [...seen].filter((n) => !allowed.has(n));

  if (missing.length > 0 || duplicates.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(`缺失 ${missing.length} 个基线 case：${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`);
    }
    if (duplicates.length > 0) {
      parts.push(`重复 ${[...new Set(duplicates)].join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`混入非比较项 ${extra.length} 个：${extra.slice(0, 5).join(", ")}${extra.length > 5 ? " …" : ""}`);
    }
    throw new Error(`比较集合与基线固定名称集合不一致：${parts.join("；")}`);
  }

  return { cases: suiteA.map((x) => x.case), suiteBCases };
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

/**
 * 脚本入口：比较集合不一致 ⇒ 明确报错并**非零退出**（拒绝比较）。
 */
function main() {
  const surface = toolSurface();
  // 比较集合的唯一依据：baseline.json 的 case 名称集合。
  const baselineNames = baselineCaseNames(DEFAULT_REPORT);
  const primary = benchReport(
    flagValue("--report") ? resolveArgPath(flagValue("--report")) : DEFAULT_REPORT,
    { baselineNames },
  );
  const compareTo = flagValue("--compare")
    ? benchReport(resolveArgPath(flagValue("--compare")), { baselineNames })
    : null;
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
      console.log(
        `生成于 ${primary.generatedAt}，${primary.cases} 个 case（比较集合，suite B 另计 ${primary.suiteBCases} 个）`,
      );
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
}

/** 作为脚本直接运行时才执行（被单测 import 时只取纯函数）。 */
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
