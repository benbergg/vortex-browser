#!/usr/bin/env node
// vortex-bench v0.6 CLI
// 前置：playground 已起（pnpm playground）、vortex-server ws 6800、Chrome extension 已加载。

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCase } from "./runner/run-case.js";
import { aggregate } from "./runner/aggregate.js";
import { diffReports, renderDiffTable, hasCritical } from "./runner/diff.js";
import {
  summarizeBoxesBudget,
  passesGate,
  renderBoxesBudgetTable,
} from "./runner/boxes-budget.js";
import type { BenchReport, CaseDefinition, CaseMetrics } from "./types.js";
import { scanFixture } from "./runner/scan.js";
import { renderScanMarkdown, rankFindings } from "./scan-report.js";
import type { FixtureScanResult, ScanReport, SynthManifest } from "./scan-types.js";
import { captureSnapshot } from "./runner/snapshot.js";
import { probeFixture } from "./runner/robustness.js";
import { probeLive, type LiveTarget } from "./runner/robustness-live.js";
import { renderRobustnessMarkdown, rankRobustnessFindings } from "./robustness-report.js";
import type { FixtureRobustness, RobustnessReport } from "./robustness-types.js";
import { judgePage, type JudgeTarget } from "./runner/judge.js";
import { renderJudgeMarkdown } from "./judge-report.js";
import type { JudgeReport, JudgePageResult } from "./judge-types.js";
import { resolveProfile } from "./runner/judge-screenshot-profile.js";
import type { ScreenshotProfile } from "./runner/judge-screenshot-profile.js";
import { generate } from "./runner/fuzz-generate.js";
import { runPage, runSelfTest, cleanupTmp, extractDiscrepancies, selfTestPassed } from "./runner/fuzz-run.js";
import { shrink } from "./runner/fuzz-shrink.js";
import { promote } from "./runner/fuzz-promote.js";
import { renderFuzzMarkdown } from "./fuzz-report.js";
import type { FuzzReport, FuzzFinding, FuzzPage } from "./fuzz-types.js";

const USAGE = `vortex-bench <command>

Commands:
  run <caseName>         跑单个 case（e.g. el-dropdown）
  run --all              跑 cases/ 下全部
  run --repeats N        每个 case 跑 N 次，median 聚合 + majority-pass
                         （recommended for baseline refresh: N=3）
  diff                   跟 reports/baseline.json 对比
  baseline               把最近一次 latest.json 存成 baseline.json
  compare-boxes [--all] [cases...]
                         issue #21 token budget sweep: 跑同一组 case 两遍
                         （baseline vs includeBoxes:true），输出 ratio /
                         median / p95 / max + reports/boxes-budget-*.json
  scan --all             扫全部合成 fixture,产 reports/scan/<ts>.{md,json}
  scan --pattern <name>  扫单个 pattern
  snapshot <name>        冻结当前活动 tab 为 synth/<name>.html + 提议 manifest
  snapshot <name> --url <u>  先 navigate 再冻结
  robustness --all       探全部 fixture 的 observe→act 契约,产 reports/robustness/<ts>.{md,json}
  robustness --pattern <name>  探单个 fixture
  robustness --url <url>       live 只读探单个真站 observe→act 契约
  robustness --current-tab     live 只读探当前已加载/已登录 tab
  robustness --seeds [file]    live 批量探种子列表(默认 live-seeds.json)
  judge --all            synth 全量 + 消融校准(产 FP/TP 表;需 DOUBAO_API_KEY)
  judge --pattern <name> 单 synth fixture 校准
  judge --url <url>      live 真站单页判 recall-miss
  judge --seeds [file]   live 批量种子
  judge --current-tab    当前已加载/已登录 tab
  judge --model <id>     切模型(默认 doubao-1-5-vision-pro-32k-250115;火山方舟 model ID)
  judge --ablate <k>     synth 消融抽行数(默认 3)
  judge --screenshot-profile <name>
                         截图 profile(q70|q85|q85+dpr2|q85+dpr2+png|q85+dpr2+png+per-frame)
                         默认 q70(jpeg quality=70, dpr=1)
  fuzz --seeds N         生成 N 个 seed 跑 observe-正确性 fuzzing(默认 50)
  fuzz --seed S          只跑单个 seed S(复现)
  fuzz --no-promote      不沉淀,只报告
  --help                 显示帮助

Env:
  VORTEX_MCP_BIN         默认 ../mcp/dist/src/server.js
  PLAYGROUND_URL         默认 http://localhost:5173
  DOUBAO_API_KEY         judge 子命令必需(火山方舟 https://ark.cn-beijing.volces.com API key)
`;

const HERE = dirname(fileURLToPath(import.meta.url));
// 本文件被 tsx 跑时在 src/，被 tsc build 后在 dist/；两种都从它的上级找资源。
const PKG_ROOT = resolve(HERE, "..");
const CASES_DIR = resolve(PKG_ROOT, "cases");
const REPORTS_DIR = resolve(PKG_ROOT, "reports");
const SYNTH_DIR = resolve(PKG_ROOT, "playground", "public", "synth");
const SCAN_REPORTS_DIR = resolve(REPORTS_DIR, "scan");
const ROBUSTNESS_REPORTS_DIR = resolve(REPORTS_DIR, "robustness");
const ROBUSTNESS_LIVE_REPORTS_DIR = resolve(REPORTS_DIR, "robustness-live");
const JUDGE_REPORTS_DIR = resolve(REPORTS_DIR, "judge");
const FUZZ_REPORTS_DIR = resolve(REPORTS_DIR, "fuzz");

function resolveMcpBin(): string {
  if (process.env.VORTEX_MCP_BIN) return resolve(process.env.VORTEX_MCP_BIN);
  return resolve(PKG_ROOT, "..", "mcp", "dist", "src", "server.js");
}

function playgroundUrl(): string {
  return process.env.PLAYGROUND_URL ?? "http://localhost:5173";
}

async function loadCase(name: string): Promise<CaseDefinition> {
  const path = resolve(CASES_DIR, `${name}.case.ts`);
  const mod = (await import(pathToFileURL(path).href)) as { default: CaseDefinition };
  if (!mod.default || typeof mod.default.run !== "function") {
    throw new Error(`case ${name} 导出不是 CaseDefinition (缺 default.run)`);
  }
  return mod.default;
}

async function listCaseNames(): Promise<string[]> {
  const entries = await readdir(CASES_DIR);
  return entries
    .filter((e) => e.endsWith(".case.ts"))
    .map((e) => e.replace(/\.case\.ts$/, ""))
    .sort();
}

/**
 * Parse `--repeats=N` or `--repeats N` from argv.
 * Returns null on invalid input (caller surfaces the user-facing error),
 * defaults to 1 when the flag is absent.
 */
function parseRepeats(args: string[]): number | null {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repeats") {
      raw = args[i + 1];
      break;
    }
    if (a.startsWith("--repeats=")) {
      raw = a.slice("--repeats=".length);
      break;
    }
  }
  if (raw === undefined) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function formatRow(m: CaseMetrics): string {
  const status = m.passed ? "✓" : "✗";
  const bytesKB = ((m.outputBytes ?? 0) / 1024).toFixed(1);
  const cls = m.failureClass ? `[${m.failureClass}] ` : "";
  const repeats =
    m.repeats !== undefined && m.repeats > 1
      ? ` n=${m.repeats} pass=${(m.passRate ?? 0).toFixed(2)}`
      : "";
  return `${status} ${m.case.padEnd(32)} calls=${String(m.callCount).padStart(3)} fallback=${m.fallbackToEvaluate} missed=${m.observeMissedPopperItems} bytes=${bytesKB.padStart(6)}KB ${m.durationMs}ms${repeats}${m.failureReason ? `  ← ${cls}${m.failureReason}` : ""}`;
}

async function writeLatest(report: BenchReport): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, "latest.json");
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

async function cmdRun(args: string[]): Promise<number> {
  const runAll = args.includes("--all");
  const repeats = parseRepeats(args);
  if (repeats === null) {
    process.stderr.write("[vortex-bench] --repeats expects a positive integer (e.g. --repeats 3)\n");
    return 1;
  }
  const caseNames = runAll
    ? await listCaseNames()
    : args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a)); // 排除 --repeats 的 N 数值

  if (caseNames.length === 0) {
    process.stderr.write("[vortex-bench] run 需要 <caseName> 或 --all\n");
    return 1;
  }

  const mcpBin = resolveMcpBin();
  const url = playgroundUrl();
  const repeatsMsg = repeats > 1 ? ` (×${repeats} runs, median + majority-pass)` : "";
  process.stdout.write(`[vortex-bench] playground=${url}  mcp=${mcpBin}\n`);
  process.stdout.write(`[vortex-bench] 跑 ${caseNames.length} 个 case${repeatsMsg}\n\n`);

  const results: CaseMetrics[] = [];
  for (const name of caseNames) {
    const def = await loadCase(name);
    const runs: CaseMetrics[] = [];
    for (let i = 0; i < repeats; i++) {
      runs.push(await runCase(def, { mcpBin, playgroundUrl: url }));
    }
    const m = aggregate(runs);
    results.push(m);
    process.stdout.write(formatRow(m) + "\n");
  }

  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    playgroundUrl: url,
    cases: results,
  };
  const path = await writeLatest(report);
  process.stdout.write(`\n[report] ${path}\n`);

  const failed = results.filter((r) => !r.passed).length;
  return failed === 0 ? 0 : 2;
}

async function cmdDiff(): Promise<number> {
  const basePath = join(REPORTS_DIR, "baseline.json");
  const latestPath = join(REPORTS_DIR, "latest.json");
  let baseline: BenchReport;
  try {
    baseline = JSON.parse(await readFile(basePath, "utf-8")) as BenchReport;
  } catch {
    process.stderr.write(`[vortex-bench] baseline 不存在：${basePath}（先跑 run --all 再 baseline）\n`);
    return 1;
  }
  const latest = JSON.parse(await readFile(latestPath, "utf-8")) as BenchReport;
  const diffs = diffReports(baseline, latest);
  process.stdout.write(renderDiffTable(diffs) + "\n");
  return hasCritical(diffs) ? 2 : 0;
}

async function cmdCompareBoxes(args: string[]): Promise<number> {
  const runAll = args.includes("--all");
  const caseNames = runAll
    ? await listCaseNames()
    : args.filter((a) => !a.startsWith("-"));

  if (caseNames.length === 0) {
    process.stderr.write("[vortex-bench] compare-boxes 需要 <caseName> 或 --all\n");
    return 1;
  }

  const mcpBin = resolveMcpBin();
  const url = playgroundUrl();
  process.stdout.write(`[vortex-bench] compare-boxes  playground=${url}  mcp=${mcpBin}\n`);
  process.stdout.write(`[vortex-bench] 跑 ${caseNames.length} 个 case × 2 passes (baseline vs includeBoxes:true)\n\n`);

  async function runPass(label: string, argOverrides?: Record<string, Record<string, unknown>>): Promise<CaseMetrics[]> {
    process.stdout.write(`── pass: ${label} ──\n`);
    const results: CaseMetrics[] = [];
    for (const name of caseNames) {
      const def = await loadCase(name);
      const m = await runCase(def, { mcpBin, playgroundUrl: url, argOverrides });
      results.push(m);
      process.stdout.write(formatRow(m) + "\n");
    }
    process.stdout.write("\n");
    return results;
  }

  const before = await runPass("baseline (no includeBoxes)");
  const after = await runPass("includeBoxes:true", {
    vortex_observe: { includeBoxes: true },
  });

  const summary = summarizeBoxesBudget(before, after);
  summary.generatedAt = new Date().toISOString();

  process.stdout.write(renderBoxesBudgetTable(summary) + "\n\n");

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = summary.generatedAt.replace(/[:.]/g, "-");
  const reportPath = join(REPORTS_DIR, `boxes-budget-${stamp}.json`);
  await writeFile(reportPath, JSON.stringify(summary, null, 2));
  process.stdout.write(`[report] ${reportPath}\n`);

  // SPEC R6 gate: median AND p95 ≤ summary.ceiling (currently
  // SPEC_R6_CEILING = 1.60; see boxes-budget.ts for the reflexion note
  // on why 1.20 → 1.60). The ceiling lives inside the report so the
  // CLI, the render label, and this gate all reference one source of
  // truth. Exit 0 = gate pass, 3 = gate fail (distinct from 2 which
  // `run` uses for case failures).
  return passesGate(summary) ? 0 : 3;
}

async function cmdBaseline(): Promise<number> {
  const latestPath = join(REPORTS_DIR, "latest.json");
  const basePath = join(REPORTS_DIR, "baseline.json");
  const raw = await readFile(latestPath, "utf-8");
  await writeFile(basePath, raw);
  process.stdout.write(`[vortex-bench] 更新 baseline: ${basePath}\n`);
  return 0;
}

async function listSynthManifests(): Promise<string[]> {
  const entries = await readdir(SYNTH_DIR);
  return entries
    .filter((e) => e.endsWith(".manifest.json"))
    .map((e) => e.replace(/\.manifest\.json$/, ""))
    .sort();
}

async function loadManifest(name: string): Promise<SynthManifest> {
  const path = resolve(SYNTH_DIR, `${name}.manifest.json`);
  const m = JSON.parse(await readFile(path, "utf-8")) as SynthManifest;
  if (!m.fixture || !m.path || !Array.isArray(m.entries)) {
    throw new Error(`manifest ${name} 结构非法(需 fixture/path/entries)`);
  }
  return m;
}

/** #2:提议稿未确认 → scan 跳过(返回 true 表示应跳过) */
function isProposed(m: SynthManifest): boolean {
  return m._proposed === true;
}

async function cmdScan(args: string[]): Promise<number> {
  const runAll = args.includes("--all");
  let names: string[];
  if (runAll) {
    names = await listSynthManifests();
  } else {
    const patternIdx = args.indexOf("--pattern");
    if (patternIdx >= 0 && args[patternIdx + 1]) names = [args[patternIdx + 1]];
    else names = args.filter((a) => !a.startsWith("-"));
  }
  if (names.length === 0) {
    process.stderr.write("[vortex-bench] scan 需要 --all 或 --pattern <name> 或 <name...>\n");
    return 1;
  }

  const mcpBin = resolveMcpBin();
  const url = playgroundUrl();
  process.stdout.write(`[vortex-bench] scan  playground=${url}  mcp=${mcpBin}\n`);
  process.stdout.write(`[vortex-bench] 扫 ${names.length} 个合成 fixture\n\n`);

  const report: ScanReport = { generatedAt: new Date().toISOString(), playgroundUrl: url, fixtures: [], findings: [] };
  for (const name of names) {
    let fx: FixtureScanResult;
    try {
      const manifest = await loadManifest(name);
      if (isProposed(manifest)) {
        process.stdout.write(`⊘ ${name.padEnd(28)} 跳过未审提议稿(_proposed:true)\n`);
        continue;
      }
      fx = await scanFixture(manifest, { mcpBin, playgroundUrl: url });
    } catch (e) {
      // manifest 缺失/非法等:记为该 fixture 的 error,不中断整轮扫描
      fx = {
        fixture: name, pattern: name, path: "",
        recall: { matched: 0, expected: 0 }, precision: { matchedNoise: 0, emitted: 0 },
        invariants: { inv1: false, inv2: false, inv3: false, inv4: false },
        findings: [], error: `加载/扫描失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    report.fixtures.push(fx);
    report.findings.push(...fx.findings);
    const p0 = fx.findings.filter((f) => f.severity === "P0").length;
    process.stdout.write(
      `${p0 === 0 ? "✓" : "✗"} ${name.padEnd(28)} recall=${fx.recall.matched}/${fx.recall.expected} ` +
      `P0=${p0} findings=${fx.findings.length}${fx.error ? `  ⚠ ${fx.error}` : ""}\n`,
    );
  }
  report.findings = rankFindings(report.findings);

  await mkdir(SCAN_REPORTS_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = join(SCAN_REPORTS_DIR, `${stamp}.json`);
  const mdPath = join(SCAN_REPORTS_DIR, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, renderScanMarkdown(report));
  process.stdout.write(`\n[report] ${mdPath}\n[report] ${jsonPath}\n`);

  const totalP0 = report.findings.filter((f) => f.severity === "P0").length;
  return totalP0 === 0 ? 0 : 2;
}

async function cmdSnapshot(args: string[]): Promise<number> {
  // bench snapshot <name> [--url <url>] [--frames <main|all-same-origin|all-permitted>]
  const urlIdx = args.indexOf("--url");
  const url = urlIdx >= 0 ? args[urlIdx + 1] : undefined;
  const framesIdx = args.indexOf("--frames");
  const frames = framesIdx >= 0 ? args[framesIdx + 1] : undefined;
  // name = 第一个既非 flag 也非 flag 值的位置参数(防 --url <url> 在前时误选 url 为 name)
  const consumed = new Set<number>();
  if (urlIdx >= 0) { consumed.add(urlIdx); consumed.add(urlIdx + 1); }
  if (framesIdx >= 0) { consumed.add(framesIdx); consumed.add(framesIdx + 1); }
  const name = args.find((a, i) => !consumed.has(i) && !a.startsWith("-"));
  if (!name) {
    process.stderr.write("[vortex-bench] snapshot 需要 <name>(产出 synth/<name>.html + .manifest.json)\n");
    return 1;
  }

  const mcpBin = resolveMcpBin();
  process.stdout.write(`[vortex-bench] snapshot ${name}  mcp=${mcpBin}${url ? `  url=${url}` : "  (当前活动 tab)"}\n`);

  const res = await captureSnapshot({
    mcpBin, name, synthDir: SYNTH_DIR, url,
    frames: frames as "main" | "all-same-origin" | "all-permitted" | undefined,
  });

  process.stdout.write(
    `✓ 冻结 ${res.observeRowCount} observe 行 / ${res.candidateCount} 候选\n` +
    `  来源: ${res.source}\n` +
    `  _review: observe-missed=${res.review.observeMissed} observe-extra=${res.review.observeExtra} agree=${res.review.agree}\n` +
    `  [html] ${res.htmlPath}\n  [manifest 提议稿] ${res.manifestPath}\n` +
    `  ⚠ 提议稿带 _proposed:true,scan 会跳过 —— 人工审定 interactive/name 后去掉 _proposed 再 scan\n`,
  );
  return 0;
}

async function cmdRobustness(args: string[]): Promise<number> {
  // live 模式:--url / --current-tab / --seeds
  const urlIdx = args.indexOf("--url");
  if (urlIdx >= 0 && args[urlIdx + 1]) return cmdRobustnessLive([{ url: args[urlIdx + 1] }]);
  if (args.includes("--current-tab")) return cmdRobustnessLive([{ currentTab: true }]);
  const seedsIdx = args.indexOf("--seeds");
  if (seedsIdx >= 0) {
    const file = args[seedsIdx + 1] && !args[seedsIdx + 1].startsWith("-")
      ? resolve(args[seedsIdx + 1])
      : resolve(PKG_ROOT, "live-seeds.json");
    const urls = await loadSeeds(file);
    return cmdRobustnessLive(urls.map((url) => ({ url })));
  }

  const runAll = args.includes("--all");
  let names: string[];
  if (runAll) {
    names = await listSynthManifests();
  } else {
    const patternIdx = args.indexOf("--pattern");
    if (patternIdx >= 0 && args[patternIdx + 1]) names = [args[patternIdx + 1]];
    else names = args.filter((a) => !a.startsWith("-"));
  }
  if (names.length === 0) {
    process.stderr.write("[vortex-bench] robustness 需要 --all 或 --pattern <name> 或 <name...>\n");
    return 1;
  }

  const mcpBin = resolveMcpBin();
  const url = playgroundUrl();
  process.stdout.write(`[vortex-bench] robustness  playground=${url}  mcp=${mcpBin}\n`);
  process.stdout.write(`[vortex-bench] 探 ${names.length} 个 fixture 的 observe→act 契约\n\n`);

  const report: RobustnessReport = {
    generatedAt: new Date().toISOString(), playgroundUrl: url, fixtures: [], findings: [],
  };
  for (const name of names) {
    let fx: FixtureRobustness;
    try {
      const manifest = await loadManifest(name);
      if (isProposed(manifest)) {
        process.stdout.write(`⊘ ${name.padEnd(28)} 跳过未审提议稿(_proposed:true)\n`);
        continue;
      }
      fx = await probeFixture(manifest, { mcpBin, playgroundUrl: url });
    } catch (e) {
      fx = {
        fixture: name, path: "", totalRefs: 0, okCount: 0, okRate: 1, histogram: {},
        findings: [], error: `加载/探测失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    report.fixtures.push(fx);
    report.findings.push(...fx.findings);
    const r0 = fx.findings.filter((f) => f.severity === "R0").length;
    const r1 = fx.findings.filter((f) => f.severity === "R1").length;
    process.stdout.write(
      `${r0 === 0 ? "✓" : "✗"} ${name.padEnd(28)} refs=${fx.totalRefs} okRate=${(fx.okRate * 100).toFixed(0)}% ` +
      `R0=${r0} R1=${r1}${fx.error ? `  ⚠ ${fx.error}` : ""}\n`,
    );
  }
  report.findings = rankRobustnessFindings(report.findings);

  await mkdir(ROBUSTNESS_REPORTS_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = join(ROBUSTNESS_REPORTS_DIR, `${stamp}.json`);
  const mdPath = join(ROBUSTNESS_REPORTS_DIR, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, renderRobustnessMarkdown(report));
  process.stdout.write(`\n[report] ${mdPath}\n[report] ${jsonPath}\n`);

  const totalR0 = report.findings.filter((f) => f.severity === "R0").length;
  return totalR0 === 0 ? 0 : 2;
}

async function loadSeeds(file: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(file, "utf-8")) as { seeds?: unknown };
  if (!Array.isArray(raw.seeds)) throw new Error(`seeds 文件需含 seeds:string[](${file})`);
  return raw.seeds.map((s) => String(s));
}

async function cmdRobustnessLive(targets: LiveTarget[]): Promise<number> {
  const mcpBin = resolveMcpBin();
  process.stdout.write(`[vortex-bench] robustness LIVE  mcp=${mcpBin}\n`);
  process.stdout.write(`[vortex-bench] 只读探 ${targets.length} 个 live 目标的 observe→act 契约\n\n`);

  const report: RobustnessReport = {
    generatedAt: new Date().toISOString(), playgroundUrl: "(live)", fixtures: [], findings: [],
  };
  for (const t of targets) {
    let fx: FixtureRobustness;
    try {
      fx = await probeLive(t, { mcpBin });
    } catch (e) {
      fx = {
        fixture: t.url ?? "current-tab", path: "", totalRefs: 0, okCount: 0, okRate: 1, histogram: {},
        findings: [], error: `探测失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    report.fixtures.push(fx);
    report.findings.push(...fx.findings);
    const r0 = fx.findings.filter((f) => f.severity === "R0").length;
    const r1 = fx.findings.filter((f) => f.severity === "R1").length;
    process.stdout.write(
      `${r0 === 0 ? "✓" : "✗"} ${fx.fixture.slice(0, 40).padEnd(40)} refs=${fx.totalRefs} okRate=${(fx.okRate * 100).toFixed(0)}% ` +
      `R0=${r0} R1=${r1}${fx.error ? `  ⚠ ${fx.error}` : ""}\n`,
    );
  }
  report.findings = rankRobustnessFindings(report.findings);

  await mkdir(ROBUSTNESS_LIVE_REPORTS_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = join(ROBUSTNESS_LIVE_REPORTS_DIR, `${stamp}.json`);
  const mdPath = join(ROBUSTNESS_LIVE_REPORTS_DIR, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, renderRobustnessMarkdown(report));
  process.stdout.write(`\n[report] ${mdPath}\n[report] ${jsonPath}\n`);

  const totalR0 = report.findings.filter((f) => f.severity === "R0").length;
  return totalR0 === 0 ? 0 : 2;
}

async function cmdJudge(args: string[]): Promise<number> {
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : "doubao-1-5-vision-pro-32k-250115";
  const ablateIdx = args.indexOf("--ablate");
  const ablate = ablateIdx >= 0 && args[ablateIdx + 1] ? Number.parseInt(args[ablateIdx + 1], 10) : 3;
  const profileIdx = args.indexOf("--screenshot-profile");
  const screenshotProfile: ScreenshotProfile = resolveProfile(
    profileIdx >= 0 && args[profileIdx + 1] ? args[profileIdx + 1] : undefined,
  );
  const mcpBin = resolveMcpBin();
  const url = playgroundUrl();

  // 决定目标集 + 模式
  let targets: JudgeTarget[];
  let mode: "synth" | "live";
  const urlIdx = args.indexOf("--url");
  const seedsIdx = args.indexOf("--seeds");
  if (urlIdx >= 0 && args[urlIdx + 1]) {
    mode = "live"; targets = [{ url: args[urlIdx + 1], page: args[urlIdx + 1] }];
  } else if (args.includes("--current-tab")) {
    mode = "live"; targets = [{ currentTab: true, page: "current-tab" }];
  } else if (seedsIdx >= 0) {
    mode = "live";
    const file = args[seedsIdx + 1] && !args[seedsIdx + 1].startsWith("-")
      ? resolve(args[seedsIdx + 1]) : resolve(PKG_ROOT, "live-seeds.json");
    const urls = await loadSeeds(file);
    targets = urls.map((u) => ({ url: u, page: u }));
  } else {
    mode = "synth";
    let names: string[];
    if (args.includes("--all")) names = await listSynthManifests();
    else {
      const pIdx = args.indexOf("--pattern");
      if (pIdx >= 0 && args[pIdx + 1]) {
        names = [args[pIdx + 1]];
      } else {
        // 仿 cmdSnapshot 的 index-based consumed Set 范式:
        // 记录 flag 及其值的下标,positional name 取下标不在 consumed 且不以 - 开头的项。
        // 避免 fixture 名恰好等于 model 串或 ablate 数字时被值比较误删。
        const consumed = new Set<number>();
        if (modelIdx >= 0) { consumed.add(modelIdx); consumed.add(modelIdx + 1); }
        if (ablateIdx >= 0) { consumed.add(ablateIdx); consumed.add(ablateIdx + 1); }
        if (profileIdx >= 0) { consumed.add(profileIdx); consumed.add(profileIdx + 1); }
        names = args.filter((a, i) => !consumed.has(i) && !a.startsWith("-"));
      }
    }
    if (names.length === 0) {
      process.stderr.write("[vortex-bench] judge 需要 --all / --pattern <name> / --url / --seeds / --current-tab\n");
      return 1;
    }
    const manifests = await Promise.all(names.map((n) => loadManifest(n).catch(() => null)));
    targets = names.flatMap((n, i) => {
      const m = manifests[i];
      if (!m || isProposed(m)) return [];
      return [{ synthPath: m.path, page: n }];
    });
  }

  process.stdout.write(`[vortex-bench] judge  mode=${mode}  model=${model}  profile=${screenshotProfile.name}  mcp=${mcpBin}\n`);
  process.stdout.write(`[vortex-bench] 判 ${targets.length} 个 page 的 observe recall-miss\n\n`);

  const report: JudgeReport = {
    generatedAt: new Date().toISOString(),
    model,
    mode,
    profile: { name: screenshotProfile.name },
    pages: [],
    findings: [],
  };
  for (const t of targets) {
    let p: JudgePageResult;
    try {
      p = await judgePage(t, { mcpBin, model, playgroundUrl: url, ablate, screenshotProfile });
    } catch (e) {
      p = { page: t.page, totalObserveRows: 0, confirmedMisses: [], findings: [], error: e instanceof Error ? e.message : String(e) };
    }
    report.pages.push(p);
    report.findings.push(...p.findings);
    if (mode === "synth" && p.calibration) {
      const c = p.calibration;
      process.stdout.write(`• ${p.page.padEnd(28)} FP=${c.fpConfirmed} TP=${c.ablatedRecovered}/${c.ablatedCount}${p.error ? `  ⚠ ${p.error}` : ""}\n`);
    } else {
      process.stdout.write(`${p.findings.length === 0 ? "✓" : "✗"} ${p.page.slice(0, 40).padEnd(40)} recall-miss=${p.findings.length}${p.error ? `  ⚠ ${p.error}` : ""}\n`);
    }
  }

  await mkdir(JUDGE_REPORTS_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const profileName = screenshotProfile.name;
  const jsonPath = join(JUDGE_REPORTS_DIR, `profile-${profileName}-${stamp}.json`);
  const mdPath = join(JUDGE_REPORTS_DIR, `profile-${profileName}-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, renderJudgeMarkdown(report));
  process.stdout.write(`\n[report] ${mdPath}\n[report] ${jsonPath}\n`);
  return 0; // judge 是抽样咨询层,非硬门(findings 需人工分诊)
}

async function cmdFuzz(args: string[]): Promise<number> {
  const seedsIdx = args.indexOf("--seeds");
  const seedIdx = args.indexOf("--seed");
  const noPromote = args.includes("--no-promote");
  const mcpBin = resolveMcpBin();
  const url = playgroundUrl();
  const runOpts = { mcpBin, playgroundUrl: url, synthDir: SYNTH_DIR };

  let seeds: number[];
  if (seedIdx >= 0 && args[seedIdx + 1]) {
    seeds = [Number(args[seedIdx + 1])];
  } else {
    const n = seedsIdx >= 0 && args[seedsIdx + 1] ? Number(args[seedsIdx + 1]) : 50;
    seeds = Array.from({ length: n }, (_, i) => i);
  }

  process.stdout.write(`[vortex-bench] fuzz  playground=${url}  seeds=${seeds.length}\n`);

  process.stdout.write(`[vortex-bench] 原语自检...\n`);
  const { scans: soloScans, quarantined } = await runSelfTest(runOpts);
  const selfTestOk = selfTestPassed(soloScans);
  if (!selfTestOk) {
    process.stderr.write(`⚠ 自检失败,隔离原语: ${quarantined.join(", ")}(继续但复合发现可能含这些原语的噪声)\n`);
  }

  const findings: FuzzFinding[] = [];
  const promoted: string[] = [];
  for (const seed of seeds) {
    const page = generate(seed);
    const scan = await runPage(page, runOpts);
    const fs = extractDiscrepancies(seed, scan);
    findings.push(...fs);

    const structural = fs.filter((f) => f.cls === "structural");
    if (structural.length > 0 && !noPromote) {
      const stillFails = async (p: FuzzPage): Promise<boolean> => {
        const s = await runPage(p, runOpts);
        return extractDiscrepancies(p.seed, s).some((f) => f.cls === "structural");
      };
      const min = await shrink(page, stillFails);
      const res = await promote(min, SYNTH_DIR, structural[0].kind);
      if (res.promoted) promoted.push(res.fixture);
      process.stdout.write(`✗ seed=${seed} structural=${structural.length} → ${res.promoted ? `沉淀 ${res.fixture}` : `已存在 ${res.fixture}`}\n`);
    } else {
      process.stdout.write(`${fs.length === 0 ? "✓" : "·"} seed=${seed} findings=${fs.length}\n`);
    }
  }

  await cleanupTmp(SYNTH_DIR);

  const report: FuzzReport = {
    generatedAt: new Date().toISOString(),
    playgroundUrl: url, seedsRun: seeds.length, selfTestOk, quarantined,
    findings, promoted,
  };
  await mkdir(FUZZ_REPORTS_DIR, { recursive: true });
  const ts = report.generatedAt.replace(/[:.]/g, "-");
  await writeFile(resolve(FUZZ_REPORTS_DIR, `${ts}.json`), JSON.stringify(report, null, 2), "utf-8");
  await writeFile(resolve(FUZZ_REPORTS_DIR, `${ts}.md`), renderFuzzMarkdown(report), "utf-8");
  process.stdout.write(`\n[vortex-bench] fuzz 完成: structural=${findings.filter((f) => f.cls === "structural").length} name=${findings.filter((f) => f.cls === "name").length} 沉淀=${promoted.length}\n`);
  return 0;
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "diff":
      return cmdDiff();
    case "baseline":
      return cmdBaseline();
    case "compare-boxes":
      return cmdCompareBoxes(rest);
    case "scan":
      return cmdScan(rest);
    case "snapshot":
      return cmdSnapshot(rest);
    case "robustness":
      return cmdRobustness(rest);
    case "judge":
      return cmdJudge(rest);
    case "fuzz":
      return cmdFuzz(rest);
    default:
      process.stderr.write(`[vortex-bench] 未知命令: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

const isDirectRun = process.argv[1]
  ? fileURLToPath(import.meta.url) === process.argv[1] ||
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[vortex-bench] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
      process.exit(1);
    },
  );
}
