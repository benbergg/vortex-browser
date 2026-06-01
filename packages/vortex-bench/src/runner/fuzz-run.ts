// packages/vortex-bench/src/runner/fuzz-run.ts
// fuzz 跑一页:写临时 html → 跑 scanFixture → 提取分歧。
// 纯函数(extractDiscrepancies / selfTestPassed)离线可测;runPage 需活 MCP(后续任务追加)。

import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { FixtureScanResult } from "../scan-types.js";
import type { FuzzFinding, FuzzPage, PrimitiveKind } from "../fuzz-types.js";
import { scanFixture, type ScanOptions } from "./scan.js";
import { renderHtml, deriveManifest } from "./fuzz-ast.js";
import { ALL_PRIMITIVE_KINDS } from "./fuzz-generate.js";

const STRUCTURAL_KINDS = new Set(["recall-miss", "precision-miss"]);

/** scan 结果 → fuzz finding(只取 recall/precision/name,忽略 invariant) */
export function extractDiscrepancies(seed: number, scan: FixtureScanResult): FuzzFinding[] {
  const out: FuzzFinding[] = [];
  for (const f of scan.findings) {
    if (f.kind === "recall-miss" || f.kind === "precision-miss") {
      out.push({ seed, cls: "structural", kind: f.kind, detail: f.detail, oracleId: f.oracleId });
    } else if (f.kind === "name-mismatch") {
      out.push({ seed, cls: "name", kind: "name-mismatch", detail: f.detail, oracleId: f.oracleId });
    }
    // inv*-/role-mismatch 不进 fuzz finding(首切聚焦 observe 漏报/误报/命名)
  }
  return out;
}

/** 原语单体自检:任一单体页出结构性 finding → 自检失败(契约未对齐/原语自身 bug) */
export function selfTestPassed(soloScans: FixtureScanResult[]): boolean {
  return soloScans.every((s) => !s.findings.some((f) => STRUCTURAL_KINDS.has(f.kind)));
}

export interface FuzzRunOptions extends ScanOptions {
  /** synth 目录绝对路径(临时页写这里的 .fuzz-tmp/) */
  synthDir: string;
}

const TMP_SUBDIR = ".fuzz-tmp";

/** 把一页写到临时目录,跑 scanFixture,返回结果。调用方负责提取分歧。 */
export async function runPage(page: FuzzPage, opts: FuzzRunOptions): Promise<FixtureScanResult> {
  const tmpDir = resolve(opts.synthDir, TMP_SUBDIR);
  await mkdir(tmpDir, { recursive: true });
  const fname = `${page.seed}.html`;
  const fixture = `fuzz-${page.seed}`;
  const relPath = `/synth/${TMP_SUBDIR}/${fname}`;
  await writeFile(resolve(tmpDir, fname), renderHtml(page), "utf-8");
  const manifest = deriveManifest(page, fixture, relPath);
  return scanFixture(manifest, { mcpBin: opts.mcpBin, playgroundUrl: opts.playgroundUrl });
}

/** 每个原语生成无噪声单体页,各跑一次 scan → 用于自检门 */
export async function runSelfTest(
  opts: FuzzRunOptions,
): Promise<{ scans: FixtureScanResult[]; quarantined: PrimitiveKind[] }> {
  const scans: FixtureScanResult[] = [];
  const quarantined: PrimitiveKind[] = [];
  let idx = 0;
  for (const kind of ALL_PRIMITIVE_KINDS) {
    // 每个单体页用 kind 作为名称,确保 srcdoc-button 的 name-join 不会与其他页面产生
    // 歧义命中(所有 solo 页同名 "保存" 会让 srcdoc 的 name-join 结果不可区分)
    const page: FuzzPage = {
      seed: -1 - idx++,
      root: { type: "noise", tag: "div", className: "solo",
        children: [{ type: "primitive", kind, id: "solo", name: kind }] },
    };
    const scan = await runPage(page, opts);
    scans.push(scan);
    if (scan.findings.some((f) => f.kind === "recall-miss" || f.kind === "precision-miss")) {
      quarantined.push(kind);
    }
  }
  return { scans, quarantined };
}

/** 清理临时目录 */
export async function cleanupTmp(synthDir: string): Promise<void> {
  await rm(resolve(synthDir, TMP_SUBDIR), { recursive: true, force: true });
}
