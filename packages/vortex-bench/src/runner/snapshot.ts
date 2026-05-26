// packages/vortex-bench/src/runner/snapshot.ts
// bench snapshot 编排:(可选 navigate)→ evaluate 注入序列化器 → observe(includeBoxes)
// → proposeManifest 算 delta → 写 synth/<name>.html + synth/<name>.manifest.json。

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createMcpConnection, closeMcpConnection } from "./mcp-client.js";
import { parseObserveSnapshot } from "./observe-parser.js";
import { proposeManifest } from "./propose-manifest.js";
import { SERIALIZE_SNAPSHOT_CODE } from "../page-side/serialize-snapshot.js";
import type { SerializeResult } from "../snapshot-types.js";

export interface SnapshotOptions {
  mcpBin: string;
  /** 目标 fixture 短名,产出 <name>.html / <name>.manifest.json */
  name: string;
  /** 写入目录(playground/public/synth 的绝对路径) */
  synthDir: string;
  /** 可选:先 navigate 到此 URL;省略则捕获当前活动 tab */
  url?: string;
  /** observe frames 参数,默认 "main" */
  frames?: "main" | "all-same-origin" | "all-permitted";
}

export interface SnapshotResult {
  htmlPath: string;
  manifestPath: string;
  source: string;
  candidateCount: number;
  observeRowCount: number;
  /** 各 _review 计数,给 CLI 打印 */
  review: { observeMissed: number; observeExtra: number; agree: number };
}

function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((i) => i && typeof i === "object" && "text" in i)
    .map((i) => String((i as { text: unknown }).text))
    .join("\n");
}

export async function captureSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const frames = opts.frames ?? "main";
  const mcp = await createMcpConnection({
    command: process.execPath,
    args: [opts.mcpBin],
    env: { ...(process.env as Record<string, string>) },
  });
  const call = (name: string, args: Record<string, unknown>) =>
    mcp.client.callTool({ name, arguments: args });

  try {
    if (opts.url) {
      await call("vortex_navigate", { url: opts.url });
      await call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });
    }

    // 1) 序列化 + 提议候选(一次 evaluate)
    const serRaw = extractText(await call("vortex_evaluate", { code: SERIALIZE_SNAPSHOT_CODE }));
    if (!serRaw.trim()) {
      throw new Error("[snapshot] vortex_evaluate 返回空串,页面可能未加载完或脚本被 CSP 拦截");
    }
    let ser: SerializeResult;
    try {
      ser = JSON.parse(serRaw) as SerializeResult;
    } catch (e) {
      throw new Error(
        `[snapshot] 序列化结果非合法 JSON: ${e instanceof Error ? e.message : String(e)}; 头120字: ${serRaw.slice(0, 120)}`,
      );
    }

    // 2) 当前页 observe(includeBoxes)作 delta 对照
    const obsText = extractText(await call("vortex_observe", { frames, includeBoxes: true }));
    const parsed = parseObserveSnapshot(obsText);

    // 3) 来源 URL(observe 头部的 URL,fallback 到 opts.url)
    const source = parsed.header.url || opts.url || "(unknown)";

    // 4) 提议 manifest
    const manifest = proposeManifest(ser.candidates, parsed.rows, {
      fixture: opts.name,
      path: `/synth/${opts.name}.html`,
      source,
      capturedAt: new Date().toISOString(),
      frames,
    });

    // 5) 写文件
    await mkdir(opts.synthDir, { recursive: true });
    const htmlPath = resolve(opts.synthDir, `${opts.name}.html`);
    const manifestPath = resolve(opts.synthDir, `${opts.name}.manifest.json`);
    await writeFile(htmlPath, ser.html);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const review = { observeMissed: 0, observeExtra: 0, agree: 0 };
    for (const e of manifest.entries) {
      if (e._review === "observe-missed") review.observeMissed++;
      else if (e._review === "observe-extra") review.observeExtra++;
      else review.agree++;
    }

    return {
      htmlPath, manifestPath, source,
      candidateCount: ser.candidates.length,
      observeRowCount: parsed.rows.length,
      review,
    };
  } finally {
    await closeMcpConnection(mcp);
  }
}
