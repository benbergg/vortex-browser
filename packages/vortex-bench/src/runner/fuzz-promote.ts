// packages/vortex-bench/src/runner/fuzz-promote.ts
// 最小复现 → 永久 synth fixture。结构 hash 去重(同结构只沉淀一次)。

import { writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { renderHtml, deriveManifest } from "./fuzz-ast.js";
import type { FuzzPage } from "../fuzz-types.js";

/** 结构指纹:忽略 seed,只哈希 AST 形状 + 原语 kind/name/id 与噪声属性 */
export function structuralHash(page: FuzzPage): string {
  const canonical = JSON.stringify(page.root); // root 不含 seed
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export interface PromoteResult {
  fixture: string;
  promoted: boolean; // false=已存在(去重跳过)
}

/** 把最小复现写入 synth/fuzz-<hash>.{html,manifest.json};已存在则跳过 */
export async function promote(
  page: FuzzPage,
  synthDir: string,
  discrepancyKind: string,
): Promise<PromoteResult> {
  const hash = structuralHash(page);
  const fixture = `fuzz-${hash}`;
  const htmlPath = resolve(synthDir, `${fixture}.html`);
  const manifestPath = resolve(synthDir, `${fixture}.manifest.json`);

  const exists = await access(manifestPath).then(() => true).catch(() => false);
  if (exists) return { fixture, promoted: false };

  const relPath = `/synth/${fixture}.html`;
  const manifest = deriveManifest(page, fixture, relPath);
  const annotated = { ...manifest, _provenance: { seed: page.seed, discrepancyKind } };

  await writeFile(htmlPath, renderHtml(page), "utf-8");
  await writeFile(manifestPath, JSON.stringify(annotated, null, 2) + "\n", "utf-8");
  return { fixture, promoted: true };
}
