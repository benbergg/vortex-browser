// 深 DOM 压测执行:活浏览器。语料在页内现造,逐维度多轮量端到端耗时,
// 另在页内单独数确定量(命中测试次数/上溯步数)。纯函数在 perf-corpus / perf-report。

import { createMcpConnection, closeMcpConnection, type McpConnection } from "./mcp-client.js";
import { buildCorpus, checkStructure, DEFAULT_SHAPES } from "./perf-corpus.js";
import type { CorpusShape, DimensionSample, PerfReport, PerfRun } from "../perf-types.js";

export interface PerfRunOptions {
  mcpBin: string;
  /** 造语料用的落脚页。必须是 http(s):扩展在 about:blank 上没有注入权限 */
  pageUrl: string;
  shapes?: readonly CorpusShape[];
  /** 每个维度重复轮数,取中位数 */
  repeats?: number;
}

const DIMENSIONS = ["geometry", "text", "attrs", "contrast", "typography", "box"] as const;

function extractJson(res: unknown): Record<string, unknown> {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/**
 * 页内数确定量:命中测试次数与祖先上溯总步数,不依赖被测代码自陈。
 * 目标要深走查 —— shadow 里的元素 document.querySelectorAll 看不见;
 * 命中测试也要下钻,否则数出来的是 host 而不是探针实际做的次数。
 */
const COUNTER_SCRIPT = `(function(){
  function deepAll(sel, r, d, acc) {
    Array.prototype.push.apply(acc, r.querySelectorAll(sel));
    var all = r.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) { var s = all[i].shadowRoot; if (s && d < 8) deepAll(sel, s, d + 1, acc); }
    return acc;
  }
  var els = deepAll(".t", document, 0, []).slice(0, 50);
  var hitTests = 0, steps = 0;
  for (var i = 0; i < els.length; i++) {
    var r = els[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      var x = r.left + r.width/2, y = r.top + r.height/2;
      var hit = document.elementFromPoint(x, y); hitTests++;
      for (var d = 0; hit && hit.shadowRoot && d < 8; d++) {
        var inner = hit.shadowRoot.elementFromPoint(x, y); hitTests++;
        if (!inner || inner === hit) break;
        hit = inner;
      }
    }
    for (var a = els[i].parentElement; a; a = a.parentElement) {
      steps++;
      var cs = getComputedStyle(a);
      if (cs.backgroundImage !== "none") break;
      if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") break;
    }
  }
  return { hitTests: hitTests, steps: steps, perTarget: els.length ? Math.round(steps/els.length) : 0 };
})()`;

async function runShape(
  mcp: McpConnection,
  shape: CorpusShape,
  repeats: number,
): Promise<PerfRun> {
  const call = (name: string, args: Record<string, unknown>) =>
    mcp.client.callTool({ name, arguments: args });
  const plan = buildCorpus(shape);

  const built = extractJson(await call("vortex_evaluate", { code: plan.buildScript, timeout: 60000 }));
  const counters = extractJson(await call("vortex_evaluate", { code: COUNTER_SCRIPT, timeout: 60000 }));
  const domNodes = Number(built.domNodes ?? 0);
  const perTarget = Number(counters.perTarget ?? 0);

  const samples: DimensionSample[] = [];
  let matched = 0;
  for (const dimension of DIMENSIONS) {
    const msSamples: number[] = [];
    for (let i = 0; i < repeats; i++) {
      const t0 = Date.now();
      const res = extractJson(
        await call("vortex_query", {
          mode: "elements",
          pattern: ".t",
          maxResults: 50,
          dimensions: dimension,
        }),
      );
      msSamples.push(Date.now() - t0);
      matched = Number(res.total ?? matched);
    }
    samples.push({
      dimension,
      msSamples,
      // 命中测试只发生在 geometry;上溯只发生在 contrast。别的维度记 0 才诚实
      hitTests: dimension === "geometry" ? Number(counters.hitTests ?? 0) : 0,
      ancestorSteps: dimension === "contrast" ? Number(counters.steps ?? 0) : 0,
    });
  }

  return {
    shapeId: shape.id,
    domNodes,
    matched,
    samples,
    structuralMismatches: checkStructure(plan, {
      domNodes,
      ancestorStepsPerTarget: perTarget,
      shadowRoots: Number(built.shadowRoots ?? 0),
      maxNest: Number(built.maxNest ?? 0),
      slotsUsed: Number(built.slotsUsed ?? 0),
    }),
  };
}

export async function runPerf(opts: PerfRunOptions): Promise<PerfReport> {
  const shapes = opts.shapes ?? DEFAULT_SHAPES;
  const repeats = opts.repeats ?? 5;
  const mcp = await createMcpConnection({
    command: process.execPath,
    args: [opts.mcpBin],
    env: { ...(process.env as Record<string, string>) },
  });
  try {
    const call = (name: string, args: Record<string, unknown>) =>
      mcp.client.callTool({ name, arguments: args });
    await call("vortex_navigate", { url: opts.pageUrl });
    const ua = extractJson(
      await call("vortex_evaluate", {
        code: '(function(){return {ua:(navigator.userAgent.match(/Chrome\\/[\\d.]+/)||["?"])[0]};})()',
      }),
    );
    const runs: PerfRun[] = [];
    for (const shape of shapes) runs.push(await runShape(mcp, shape, repeats));
    return {
      generatedAt: new Date().toISOString(),
      browser: String(ua.ua ?? "unknown"),
      runs,
    };
  } finally {
    await closeMcpConnection(mcp);
  }
}
