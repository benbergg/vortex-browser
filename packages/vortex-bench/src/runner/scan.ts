// packages/vortex-bench/src/runner/scan.ts
// 单 fixture 扫描编排:navigate → observe1(includeBoxes) → evaluate oracle rects
// → INV-2 探每个 ref → observe2 → 跑 manifest-check + 4 不变量 → FixtureScanResult。
// 探测顺序固定以规避 STALE_SNAPSHOT(observe2 会让 observe1 的 ref 失效)。

import { createMcpConnection, closeMcpConnection } from "./mcp-client.js";
import { parseObserveSnapshot } from "./observe-parser.js";
import { checkManifest } from "./manifest-check.js";
import { checkStability, classifyProbe, checkDuplicates, checkBboxSanity, type ProbeResult } from "./invariants.js";
import { joinByGeometry } from "./geometry-join.js";
import type { Finding, FixtureScanResult, OracleRect, SynthManifest } from "../scan-types.js";

export interface ScanOptions {
  mcpBin: string;
  playgroundUrl: string;
}

const PROBE_TIMEOUT_MS = 5000;

function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((i) => i && typeof i === "object" && "text" in i)
    .map((i) => String((i as { text: unknown }).text))
    .join("\n");
}

const ORACLE_PROBE_CODE =
  "Array.from(document.querySelectorAll('[data-vtx-oracle]')).map(function(el){" +
  "var r=el.getBoundingClientRect();" +
  "return {id:el.getAttribute('data-vtx-oracle')," +
  "rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};})";

export async function scanFixture(manifest: SynthManifest, opts: ScanOptions): Promise<FixtureScanResult> {
  const frames = manifest.frames ?? "main";
  const result: FixtureScanResult = {
    fixture: manifest.fixture,
    pattern: manifest.entries[0]?.pattern ?? manifest.fixture,
    path: manifest.path,
    recall: { matched: 0, expected: 0 },
    precision: { matchedNoise: 0, emitted: 0 },
    invariants: { inv1: true, inv2: true, inv3: true, inv4: true },
    findings: [],
  };

  const mcp = await createMcpConnection({
    command: process.execPath,
    args: [opts.mcpBin],
    env: { ...(process.env as Record<string, string>) },
  });

  const call = (name: string, args: Record<string, unknown>) =>
    mcp.client.callTool({ name, arguments: args });

  try {
    await call("vortex_navigate", { url: "about:blank" });
    await call("vortex_navigate", { url: opts.playgroundUrl + manifest.path });
    await call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });

    // 1) observe #1 (includeBoxes) — manifest-check / INV-3 / INV-4 的数据源
    const obs1Text = extractText(await call("vortex_observe", { frames, includeBoxes: true }));
    const parsed1 = parseObserveSnapshot(obs1Text);

    // 2) oracle rect 探针(仅主 frame;跨 frame entry 走 joinBy:name)
    let oracles: OracleRect[] = [];
    try {
      oracles = JSON.parse(extractText(await call("vortex_evaluate", { code: ORACLE_PROBE_CODE }))) as OracleRect[];
    } catch (e) {
      result.error = `oracle 探针失败: ${e instanceof Error ? e.message : String(e)}`;
    }

    // manifest 裁决
    const manifestFindings = checkManifest(parsed1, oracles, manifest);
    result.findings.push(...manifestFindings);
    result.recall.expected = manifest.entries.filter((e) => e.interactive).length;
    result.recall.matched =
      result.recall.expected - manifestFindings.filter((f) => f.kind === "recall-miss").length;
    result.precision.emitted = parsed1.rows.length;
    result.precision.matchedNoise = manifestFindings.filter((f) => f.kind === "precision-miss").length;

    // INV-3 / INV-4(基于 observe #1)
    const dup = checkDuplicates(parsed1.rows, manifest.fixture, result.pattern);
    const bbox = checkBboxSanity(parsed1, manifest.fixture, result.pattern);
    result.findings.push(...dup, ...bbox);
    result.invariants.inv3 = dup.length === 0;
    result.invariants.inv4 = bbox.length === 0;

    // 3) INV-2 — 探 observe #1 每个 ref(此时仍是 active snapshot)
    for (const row of parsed1.rows) {
      const probe = await runProbe(call, row.ref);
      const verdict = classifyProbe(probe);
      if (verdict === "crash") {
        result.invariants.inv2 = false;
        result.findings.push({ fixture: manifest.fixture, pattern: result.pattern, severity: "P0",
          kind: "inv2-unresolvable", ref: row.ref,
          detail: `ref ${row.ref} 探针 ${probe.timedOut ? "超时" : "崩溃"}: ${probe.text.slice(0, 120)}` });
      }
    }

    // 4) observe #2 → INV-1 稳定性(此处才让 observe #1 的 ref 失效)
    const parsed2 = parseObserveSnapshot(extractText(await call("vortex_observe", { frames, includeBoxes: true })));
    const inv1 = checkStability(parsed1, parsed2, manifest.fixture, result.pattern);
    result.findings.push(...inv1);
    result.invariants.inv1 = inv1.length === 0;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await closeMcpConnection(mcp);
  }

  return result;
}

/** 跑一次只读 ref 探针:vortex_extract(target=@ref)。reject/超时 → crash 信号。 */
async function runProbe(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ref: string,
): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      call("vortex_extract", { target: ref, include: ["attrs"] }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("__probe_timeout__")), PROBE_TIMEOUT_MS); }),
    ]);
    return { text: extractText(res), threw: false, timedOut: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: msg, threw: msg !== "__probe_timeout__", timedOut: msg === "__probe_timeout__" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
