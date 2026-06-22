#!/usr/bin/env node
/**
 * dogfood 轮换选站 + 简报渲染 + 状态记账（纯确定性逻辑，可单独测试）。
 *
 * 用法：
 *   node scripts/dogfood-rotation.mjs pick [--site <id>] [--date YYYY-MM-DD] [--dry-run]
 *     选下一站（或 --site 强制指定），渲染 EVAL-BRIEF 到 reports/<cycle>/，
 *     stdout 打印 JSON { cycle, site, siteLabel, briefPath, cycleDir, pages }。
 *     选站优先级：未覆盖 > 上轮有真缺陷 > 最久未测；自动选站跳过 needs_login 站（仅 --site 可指定）。
 *     --dry-run：不落盘，只打印将要做什么。pick 不修改 rotation-pool.json。
 *
 *   node scripts/dogfood-rotation.mjs record --cycle <id> --site <id> \
 *        [--defects N] [--fp M] [--note "..."] [--date YYYY-MM-DD]
 *     Phase 4 记账：给该站追加 history 条目 + 更新 last_covered，写回 rotation-pool.json。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const POOL = path.join(REPO, "reports/_dogfood/rotation-pool.json");
const TEMPLATE = path.join(REPO, "reports/_dogfood/EVAL-BRIEF.template.md");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function today() {
  // 本地日期 YYYY-MM-DD（普通 Node 脚本，Date 可用）
  return new Date().toISOString().slice(0, 10);
}

function loadPool() {
  return JSON.parse(fs.readFileSync(POOL, "utf8"));
}

function latestHistory(site) {
  const h = site.history || [];
  return h.length ? h[h.length - 1] : null;
}

/** 选站：未覆盖 > 上轮有真缺陷 > 最久未测。自动选站跳过 needs_login。 */
function selectSite(pool, forcedId) {
  if (forcedId) {
    const s = pool.sites.find((x) => x.id === forcedId);
    if (!s) throw new Error(`未知站点 id: ${forcedId}（池中有 ${pool.sites.map((x) => x.id).join(", ")}）`);
    return s;
  }
  const auto = pool.sites.filter((s) => !s.needs_login);
  // tier1 未覆盖
  const neverCovered = auto.filter((s) => !s.last_covered);
  if (neverCovered.length) return neverCovered[0];
  // tier2 上轮有真缺陷（按 last_covered 最久优先）
  const hadDefects = auto
    .filter((s) => (latestHistory(s)?.vortex_defects || 0) > 0)
    .sort((a, b) => String(a.last_covered).localeCompare(String(b.last_covered)));
  if (hadDefects.length) return hadDefects[0];
  // tier3 最久未测
  return auto.slice().sort((a, b) => String(a.last_covered).localeCompare(String(b.last_covered)))[0];
}

function renderPagesTable(site) {
  const rows = [];
  rows.push("| # | 组件页 URL | 核心交互（逐个试） |");
  rows.push("|---|-----------|------------------|");
  const base = site.base_url || "";
  for (const p of site.pages || []) {
    const url = base + p.path;
    rows.push(`| ${p.id} | ${url} | ${p.interactions} |`);
  }
  for (const p of site.x_pages || []) {
    const url = (p.base || base) + p.path;
    rows.push(`| ${p.id} | ${url} | ${p.interactions} |`);
  }
  return rows.join("\n");
}

function renderBrief(site, cycleId, cycleDir) {
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  return tpl
    .replaceAll("{{SITE_LABEL}}", site.label)
    .replaceAll("{{SITE_BASE_URL}}", site.base_url || "(评测时提供)")
    .replaceAll("{{CYCLE_ID}}", cycleId)
    .replaceAll("{{CYCLE_DIR}}", cycleDir)
    .replaceAll("{{PAGES_TABLE}}", renderPagesTable(site));
}

function cmdPick(args) {
  const pool = loadPool();
  const date = typeof args.date === "string" ? args.date : today();
  const site = selectSite(pool, typeof args.site === "string" ? args.site : null);
  const cycleId = `dogfood-${site.id}-${date}`;
  const cycleDirRel = `reports/${cycleId}`;
  const cycleDir = path.join(REPO, cycleDirRel);
  const briefPathRel = `${cycleDirRel}/EVAL-BRIEF.md`;
  const brief = renderBrief(site, cycleId, cycleDirRel);

  const result = {
    cycle: cycleId,
    site: site.id,
    siteLabel: site.label,
    needsLogin: !!site.needs_login,
    briefPath: briefPathRel,
    cycleDir: cycleDirRel,
    anomaliesPath: `${cycleDirRel}/anomalies.json`,
    observationsPath: `${cycleDirRel}/eval-observations.md`,
    pages: (site.pages || []).length + (site.x_pages || []).length,
  };

  if (args["dry-run"]) {
    console.error(`[dry-run] 将选站 ${site.id}（${site.label}），渲染 brief 到 ${briefPathRel}`);
    console.log(JSON.stringify({ ...result, dryRun: true }, null, 2));
    return;
  }

  fs.mkdirSync(path.join(cycleDir, "screenshots"), { recursive: true });
  fs.writeFileSync(path.join(REPO, briefPathRel), brief);
  console.error(`已渲染 brief → ${briefPathRel}（cycle ${cycleId}）`);
  console.log(JSON.stringify(result, null, 2));
}

function cmdRecord(args) {
  const pool = loadPool();
  const siteId = args.site;
  const cycle = args.cycle;
  if (typeof siteId !== "string" || typeof cycle !== "string") {
    throw new Error("record 需要 --cycle <id> 和 --site <id>");
  }
  const site = pool.sites.find((s) => s.id === siteId);
  if (!site) throw new Error(`未知站点 id: ${siteId}`);
  const date = typeof args.date === "string" ? args.date : today();
  const entry = {
    cycle,
    date,
    vortex_defects: Number(args.defects || 0),
    false_positives: Number(args.fp || 0),
    note: typeof args.note === "string" ? args.note : "",
  };
  site.history = site.history || [];
  site.history.push(entry);
  site.last_covered = date;
  pool.updated = date;
  fs.writeFileSync(POOL, JSON.stringify(pool, null, 2) + "\n");
  console.error(`已记账 ${siteId} ← ${JSON.stringify(entry)}`);
  console.log(JSON.stringify({ ok: true, site: siteId, entry }, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "pick";
  if (cmd === "pick") cmdPick(args);
  else if (cmd === "record") cmdRecord(args);
  else {
    console.error(`未知命令: ${cmd}（支持 pick / record）`);
    process.exit(2);
  }
}

main();
