#!/usr/bin/env node
// 工具选择盲测 harness。
//
// 为什么需要它:Claude Code 的 transcript **不落 thinking 正文**(实测 3004 个块跨
// 3 模型 7 版本全为空,只留加密 signature),所以「模型为什么选 A 不选 B」永远挖不出来。
// 日志只记录发生了什么,不记录没发生什么。唯一能回答因果的手段是受控 A/B——
// 2026-08-11 实测:一次 A/B 的信息量超过 4269 条历史日志。
//
// 早停设计:主判据是**首次选择**,不是任务完成。stream-json 在权限询问之前就发出
// tool_use 事件,因此可以在工具真正执行前截停——既省一个数量级的 token,又对用户的
// 真实浏览器零副作用。
//
// 用法:
//   node scripts/choice-ab/run.mjs --label rule-in-claudemd --reps 3
//   node scripts/choice-ab/run.mjs --label baseline --tasks dev-visual,clean-account
//   node scripts/choice-ab/run.mjs --compare reports/_eval/choice-ab/<A> <B>

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startFixture } from "./fixture.mjs";
import { byId } from "./tasks.mjs";

const TOOL_RE = /^mcp__(vortex|playwright)__/;
const DEFAULT_TIMEOUT_MS = 180_000;

// MCP 不是通往 playwright 的唯一路。实测历史 transcript:MCP 967 次、Bash 里直接跑
// playwright 121 次、skill 路 1 次 —— 只数 mcp__playwright__* 会把占比算成下界。
// 三条路都要认,否则会被静默归到「未选」,而「未选」看起来像没结论,实际是漏判。
function classify(name, input) {
  if (TOOL_RE.test(name)) return { srv: TOOL_RE.exec(name)[1], route: "mcp", detail: name.replace(/^mcp__\w+__/, "") };
  if (name === "Skill") {
    const s = String(input?.skill ?? "");
    if (/playwright/i.test(s)) return { srv: "playwright", route: "skill", detail: s };
    if (/vortex/i.test(s)) return { srv: "vortex", route: "skill", detail: s };
    return null;
  }
  if (name === "Bash") {
    const cmd = String(input?.command ?? "");
    if (/playwright|puppeteer/i.test(cmd)) return { srv: "playwright", route: "bash", detail: cmd.slice(0, 60) };
    if (/\bvortex\b\s+\w/.test(cmd)) return { srv: "vortex", route: "bash", detail: cmd.slice(0, 60) };
    return null;
  }
  return null;
}

function parseArgs(argv) {
  const a = { reps: 1, tasks: [], label: "run", timeoutMs: DEFAULT_TIMEOUT_MS, full: false, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--reps") a.reps = Number(argv[++i]);
    else if (k === "--tasks") a.tasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--label") a.label = argv[++i];
    else if (k === "--timeout") a.timeoutMs = Number(argv[++i]) * 1000;
    else if (k === "--full") a.full = true;
    else if (k === "--compare") a.compare = [argv[++i], argv[++i]];
  }
  return a;
}

// 被试必须以「普通用户会话」的身份启动:继承 CLAUDECODE / CLAUDE_CODE_CHILD_SESSION
// 等变量会让它知道自己是被另一个 claude 拉起的,行为不可比。
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_|ANTHROPIC_)/.test(k)) delete env[k];
  }
  return env;
}

/** 跑一次探针,返回首次工具选择。检测到浏览器工具即杀进程(--full 则跑完) */
function probe(prompt, cwd, { timeoutMs, full }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("claude", ["-p", "--output-format", "stream-json", "--verbose", prompt], {
      cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"],
    });

    const out = { firstToolSearch: null, toolSeq: [], chosen: null, route: null, firstTool: null,
                  firstInput: null, stderr: "", elapsedMs: 0, stopped: "end" };
    let buf = "";

    const finish = (why) => {
      if (out.stopped === "done") return;
      out.stopped = why;
      out.elapsedMs = Date.now() - t0;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      out.stopped = why;
      resolve(out);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (d.type !== "assistant") continue;
        for (const b of d.message?.content ?? []) {
          if (b?.type !== "tool_use") continue;
          if (b.name === "ToolSearch" && !out.firstToolSearch) out.firstToolSearch = b.input?.query ?? "";
          out.toolSeq.push(b.name);
          const hit = out.chosen ? null : classify(b.name, b.input);
          if (hit) {
            out.chosen = hit.srv;
            out.route = hit.route;
            out.firstTool = hit.detail;
            out.firstInput = JSON.stringify(b.input ?? {}).slice(0, 160);
            if (!full) return finish("early-stop");
          }
        }
      }
    });
    child.stderr.on("data", (c) => { out.stderr += c.toString().slice(0, 500); });
    child.on("close", () => finish("end"));
    child.on("error", (e) => { out.stderr += String(e); finish("spawn-error"); });
  });
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + "%" : "-");

function summarize(records) {
  const byTask = new Map();
  for (const r of records) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r);
  }
  const lines = ["| 任务 | 预期 | vortex | playwright | 未选 | 判定 | 首个工具（路径） |",
                 "|---|---|---:|---:|---:|---|---|"];
  let pass = 0;
  for (const [task, rs] of byTask) {
    const exp = rs[0].expect;
    const v = rs.filter((r) => r.chosen === "vortex").length;
    const p = rs.filter((r) => r.chosen === "playwright").length;
    const none = rs.filter((r) => !r.chosen).length;
    const hit = rs.filter((r) => r.chosen === exp).length;
    const ok = hit === rs.length && none === 0;
    if (ok) pass++;
    const tools = [...new Set(rs.filter((r) => r.firstTool).map((r) => `${r.firstTool}(${r.route})`))].join(", ") || "—";
    lines.push(`| ${task} | ${exp} | ${v} | ${p} | ${none} | ${ok ? "✅" : `⚠️ ${hit}/${rs.length}`} | ${tools} |`);
  }
  return { table: lines.join("\n"), pass, total: byTask.size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.compare) {
    const load = (d) => readdirSync(d).filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(d, f), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
    const [A, B] = args.compare.map(load);
    console.log(`## A: ${args.compare[0]}\n\n${summarize(A).table}\n`);
    console.log(`## B: ${args.compare[1]}\n\n${summarize(B).table}`);
    return;
  }

  const tasks = byId(args.tasks);
  const fixture = await startFixture();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join("reports", "_eval", "choice-ab", `${stamp}-${args.label}`);
  mkdirSync(outDir, { recursive: true });
  const jsonl = join(outDir, "records.jsonl");

  console.log(`靶场 ${fixture.url}   工作目录 ${fixture.cwd}`);
  console.log(`变量标签 ${args.label}   任务 ${tasks.map((t) => t.id).join(",")}   重复 ${args.reps}\n`);

  const records = [];
  try {
    for (const task of tasks) {
      for (let rep = 1; rep <= args.reps; rep++) {
        const prompt = task.prompt({ port: fixture.url, url: fixture.url });
        process.stdout.write(`  ${task.id} #${rep} … `);
        const r = await probe(prompt, fixture.cwd, args);
        const rec = { task: task.id, expect: task.expect, rep, label: args.label, prompt, ...r };
        records.push(rec);
        appendFileSync(jsonl, JSON.stringify(rec) + "\n");
        const verdict = !r.chosen ? "未选浏览器工具" : r.chosen === task.expect ? `${r.chosen} ✅` : `${r.chosen} ⚠️`;
        console.log(`${verdict}  ${r.firstTool ?? ""} (${(r.elapsedMs / 1000).toFixed(0)}s, ${r.stopped})`);
      }
    }
  } finally {
    await fixture.stop();
  }

  const { table, pass, total } = summarize(records);
  const md = `# 工具选择盲测 — ${args.label}\n\n` +
    `- 时间 ${new Date().toISOString()}\n- 靶场 ${fixture.url}（harness 自带，非用户项目）\n` +
    `- 重复 ${args.reps}\n- 判据预先注册于 \`scripts/choice-ab/tasks.mjs\`\n\n` +
    `${table}\n\n通过 ${pass}/${total}\n\n原始记录：\`records.jsonl\`\n`;
  writeFileSync(join(outDir, "report.md"), md);
  console.log(`\n${table}\n\n通过 ${pass}/${total}\n报告 ${join(outDir, "report.md")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
