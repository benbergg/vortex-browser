#!/usr/bin/env node
/**
 * ship-preflight: automate the vortex ship checklist gates.
 *
 * Gates (see Knowledge-Library/07-Tech/20260512-vortex-ship-checklist.md):
 *   1. CHANGELOG [Unreleased] must be empty (already rolled into a version).
 *   2. File paths referenced in the latest version section must appear in
 *      `git diff vPREV..HEAD --name-only`.
 *   3. Numeric claims in the latest section vs same claims in commit messages
 *      (WARN on mismatch, never FAIL — best-effort cross-check).
 *   4. New silent fallback expressions (?? / ||) added in the range must
 *      have a corresponding *.test.ts touched in the same range.
 *
 * Run:
 *   pnpm ship:preflight                  # auto-detect prev tag + latest section
 *   pnpm ship:preflight --from v0.7.3    # explicit prev
 *   pnpm ship:preflight --to HEAD --version 0.7.5
 *
 * Exit codes: 0 PASS, 1 FAIL (any gate failed), 2 WARN (only warnings).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------- CLI args ----------

function parseArgs(argv) {
  const args = { to: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: pnpm ship:preflight [--from <tag>] [--to <ref>] [--version <X.Y.Z>]",
      );
      process.exit(0);
    }
  }
  return args;
}

// ---------- git helpers ----------

function git(cmd) {
  // 默认 1MB buffer 在跨多轮任务的 release range 上会 ENOBUFS,闸门直接崩掉不跑
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

function latestTag() {
  try {
    return git("tag --list 'v*' --sort=-version:refname").split("\n")[0];
  } catch {
    return git("describe --tags --abbrev=0");
  }
}

function rangeFiles(from, to) {
  return git(`diff ${from}..${to} --name-only`).split("\n").filter(Boolean);
}

function rangeAddedDiff(from, to) {
  return git(`diff ${from}..${to} --unified=0`);
}

function rangeCommitBodies(from, to) {
  return git(`log ${from}..${to} --pretty=format:%B%n----`);
}

// ---------- CHANGELOG parsing ----------

function parseChangelog(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+\[/.test(line)) {
      if (current) sections.push(current);
      current = { header: line, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);

  let unreleased = "";
  const versions = [];
  for (const s of sections) {
    const m = s.header.match(/^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?\s*$/);
    if (!m) continue;
    const tag = m[1].trim();
    const body = s.body.join("\n").trim();
    if (tag.toLowerCase() === "unreleased") {
      unreleased = body;
    } else {
      versions.push({ version: tag, date: m[2]?.trim(), body });
    }
  }
  return { unreleased, versions };
}

function findLatestVersion(versions, pin) {
  if (pin) {
    const hit = versions.find((v) => v.version === pin);
    if (!hit) throw new Error(`CHANGELOG has no section for version "${pin}"`);
    return hit;
  }
  if (versions.length === 0) throw new Error("CHANGELOG has no version sections");
  return versions[0];
}

// ---------- Gate implementations ----------

function gateUnreleasedEmpty(unreleased) {
  // Strip empty lines, italic-placeholder lines (`_..._`), and `---` rules.
  const meaningful = unreleased
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("_") && t !== "---";
    })
    .join("\n")
    .trim();
  if (!meaningful) {
    return {
      name: "Gate 1 — [Unreleased] empty",
      status: "PASS",
      details: ["No pending entries under [Unreleased]"],
    };
  }
  return {
    name: "Gate 1 — [Unreleased] empty",
    status: "FAIL",
    details: [
      "Move [Unreleased] content into the new version section before shipping:",
      ...meaningful.split("\n").map((l) => `  ${l}`),
    ],
  };
}

function extractPaths(body) {
  // Reject glob patterns (`*` `?`) — CHANGELOG sometimes uses `cases/*.case.ts`
  // as a wildcard summary rather than a literal file reference.
  const re =
    /`((?:packages|scripts|docs)\/[^\s`*?]+\.(?:ts|tsx|mjs|cjs|js|json|md))(?::\d+(?:-\d+)?)?`/g;
  const out = new Set();
  let m;
  while ((m = re.exec(body))) out.add(m[1]);
  return [...out];
}

function gatePathsTouched(body, changed) {
  const refs = extractPaths(body);
  if (refs.length === 0) {
    return {
      name: "Gate 2 — CHANGELOG paths ⊆ git diff",
      status: "WARN",
      details: ["No file paths referenced in latest section (suspicious)"],
    };
  }
  const touched = new Set(changed);
  const missing = refs.filter((p) => !touched.has(p));
  if (missing.length === 0) {
    return {
      name: "Gate 2 — CHANGELOG paths ⊆ git diff",
      status: "PASS",
      details: [`${refs.length}/${refs.length} referenced files touched in range`],
    };
  }
  return {
    name: "Gate 2 — CHANGELOG paths ⊆ git diff",
    status: "FAIL",
    details: [
      `${missing.length}/${refs.length} referenced files NOT touched in range:`,
      ...missing.map((p) => `  - ${p}`),
      "Either the path is wrong, the change was reverted, or it belongs to a prior version.",
    ],
  };
}

function extractNumericClaims(text) {
  const claims = [];
  const add = (raw, kind, value) => claims.push({ raw, kind, value });

  for (const m of text.matchAll(/(\d+)\s*\/\s*(\d+)(?=\s*(?:case|个|测试|测|test))/gi)) {
    add(m[0], "ratio", `${m[1]}/${m[2]}`);
  }
  for (const m of text.matchAll(/(\d+)\s*个?\s*(?:单测|单元测试|测试用例|cases?)/g)) {
    add(m[0], "test-count", m[1]);
  }
  for (const m of text.matchAll(/(\d+)\s*(?:处|个 site|sites?|个 handler|handlers?)/g)) {
    add(m[0], "site-count", m[1]);
  }
  for (const m of text.matchAll(/(\d+)\s*(?:个 bug|bug class(?:es)?|bugs)/gi)) {
    add(m[0], "bug-count", m[1]);
  }
  for (const m of text.matchAll(/([-+]?\d+(?:\.\d+)?)\s*%/g)) {
    add(m[0], "percent", m[1]);
  }
  return claims;
}

function gateNumericCrossCheck(body, commitBodies) {
  const inLog = new Set(
    extractNumericClaims(commitBodies).map((c) => c.raw.replace(/\s+/g, "")),
  );
  const inCl = extractNumericClaims(body);
  if (inCl.length === 0) {
    return {
      name: "Gate 3 — numeric claims cross-check",
      status: "WARN",
      details: ["No numeric claims found in CHANGELOG section"],
    };
  }
  const onlyInCl = inCl.filter((c) => !inLog.has(c.raw.replace(/\s+/g, "")));
  if (onlyInCl.length === 0) {
    return {
      name: "Gate 3 — numeric claims cross-check",
      status: "PASS",
      details: [`${inCl.length} numeric claims, all also appear in commit messages`],
    };
  }
  const tail =
    onlyInCl.length > 20 ? [`  ... and ${onlyInCl.length - 20} more`] : [];
  return {
    name: "Gate 3 — numeric claims cross-check",
    status: "WARN",
    details: [
      `${onlyInCl.length}/${inCl.length} CHANGELOG numeric claims NOT in commit messages:`,
      ...onlyInCl.slice(0, 20).map((c) => `  - [${c.kind}] "${c.raw}"`),
      ...tail,
      "Verify each manually (CHANGELOG may aggregate, or commit msg may omit).",
    ],
  };
}

function gateFallbackCoverage(diff, changed) {
  const fileHeader = /^\+\+\+\s+b\/(.+)$/;
  const addedLine = /^\+(?!\+\+)(.*)$/;
  const fallback =
    /(\?\?\s*(?:null|undefined|0|""|''|\[\])|(?<![|=!<>])\|\|\s*(?:null|undefined|0|""|''|\[\]))/;

  const hits = new Map();
  let currentFile = null;
  for (const line of diff.split("\n")) {
    const fh = line.match(fileHeader);
    if (fh) {
      currentFile = fh[1];
      continue;
    }
    if (!currentFile) continue;
    if (!currentFile.endsWith(".ts") && !currentFile.endsWith(".tsx")) continue;
    // Skip test/bench infra — these are tests themselves, not production code.
    if (currentFile.includes("/tests/") || currentFile.includes(".test.")) continue;
    if (currentFile.includes(".case.")) continue;
    if (currentFile.startsWith("packages/vortex-bench/")) continue;
    const al = line.match(addedLine);
    if (!al) continue;
    if (fallback.test(al[1])) {
      hits.set(currentFile, (hits.get(currentFile) ?? 0) + 1);
    }
  }
  if (hits.size === 0) {
    return {
      name: "Gate 4 — new silent fallbacks have tests",
      status: "PASS",
      details: ["No new `?? null|0|...` or `|| null|0|...` patterns added in range"],
    };
  }

  const testFiles = changed.filter((f) => /\.test\.(ts|tsx)$/.test(f));
  // Heuristic: any test file inside the same package counts as coverage.
  // (basename matching mis-fires for helpers tested under a different name
  // — e.g. v0.7.4 tab-utils.ts is covered by frame-detach.test.ts.)
  const packageOf = (f) => {
    const m = f.match(/^(packages\/[^/]+)\//);
    return m ? m[1] : null;
  };
  const missing = [];
  for (const [file, count] of hits) {
    const pkg = packageOf(file);
    const hasTest =
      pkg && testFiles.some((t) => t.startsWith(pkg + "/"));
    if (!hasTest) {
      missing.push(
        `${file} (+${count} fallback) — no *.test.ts under ${pkg ?? "<unknown>"} in range`,
      );
    }
  }
  if (missing.length === 0) {
    return {
      name: "Gate 4 — new silent fallbacks have tests",
      status: "PASS",
      details: [...hits.entries()].map(
        ([f, n]) => `  +${n} fallback in ${f} → matching test file touched`,
      ),
    };
  }
  return {
    name: "Gate 4 — new silent fallbacks have tests",
    status: "WARN",
    details: [
      `${missing.length} file(s) added silent fallbacks without matching test changes:`,
      ...missing.map((l) => `  - ${l}`),
      "Add an upstream-failed test for each (see checklist Gate 5).",
    ],
  };
}

// ---------- Reporter ----------

function statusBadge(s) {
  return s === "PASS" ? "✓ PASS" : s === "WARN" ? "⚠ WARN" : "✗ FAIL";
}

function render(resolvedFrom, resolvedTo, versionTag, results) {
  const lines = [];
  lines.push(`# ship preflight — ${versionTag}`);
  lines.push("");
  lines.push(`Range: \`${resolvedFrom}..${resolvedTo}\``);
  lines.push(
    `Checklist: \`Knowledge-Library/07-Tech/20260512-vortex-ship-checklist.md\``,
  );
  lines.push("");
  for (const r of results) {
    lines.push(`## ${statusBadge(r.status)} ${r.name}`);
    lines.push("");
    for (const d of r.details) lines.push(d);
    lines.push("");
  }
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  const passes = results.filter((r) => r.status === "PASS").length;
  lines.push("---");
  lines.push(
    `Summary: ${passes} PASS · ${warns} WARN · ${fails} FAIL` +
      " (gates beyond automation: reflexion 双轮 + grep-verified claims — manual)",
  );
  return lines.join("\n");
}

// ---------- Main ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolvedFrom = args.from ?? latestTag();
  const resolvedTo = args.to;

  const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
  const { unreleased, versions } = parseChangelog(changelog);
  const section = findLatestVersion(versions, args.version);
  const versionTag = `[${section.version}]${section.date ? ` - ${section.date}` : ""}`;

  const changed = rangeFiles(resolvedFrom, resolvedTo);
  const commitBodies = rangeCommitBodies(resolvedFrom, resolvedTo);
  const diff = rangeAddedDiff(resolvedFrom, resolvedTo);

  const results = [
    gateUnreleasedEmpty(unreleased),
    gatePathsTouched(section.body, changed),
    gateNumericCrossCheck(section.body, commitBodies),
    gateFallbackCoverage(diff, changed),
  ];

  console.log(render(resolvedFrom, resolvedTo, versionTag, results));

  const hasFail = results.some((r) => r.status === "FAIL");
  const hasWarn = results.some((r) => r.status === "WARN");
  process.exit(hasFail ? 1 : hasWarn ? 2 : 0);
}

main();
