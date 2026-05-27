// packages/vortex-bench/src/runner/robustness.ts
// 单 fixture 健壮性探测编排(需活 MCP)。每 ref 独立隔离:重导航 → observe → click rows[i]。
// 见设计 §3.1:teleport 类 mutating click 不污染其他 ref,R0 语义最精确。

import { createMcpConnection, closeMcpConnection } from "./mcp-client.js";
import { parseObserveSnapshot } from "./observe-parser.js";
import { classifyAct, type ActResult } from "./robustness-classify.js";
import { aggregateFixture } from "./robustness-aggregate.js";
import type { FixtureRobustness, RefOutcome } from "../robustness-types.js";
import type { ParsedObserve, SynthManifest } from "../scan-types.js";

export interface RobustnessOptions {
  mcpBin: string;
  playgroundUrl: string;
}

const ACT_TIMEOUT_MS = 5000;

function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((i) => i && typeof i === "object" && "text" in i)
    .map((i) => String((i as { text: unknown }).text))
    .join("\n");
}

export async function probeFixture(
  manifest: SynthManifest,
  opts: RobustnessOptions,
): Promise<FixtureRobustness> {
  const frames = manifest.frames ?? "main";
  const mcp = await createMcpConnection({
    command: process.execPath,
    args: [opts.mcpBin],
    env: { ...(process.env as Record<string, string>) },
  });
  const call = (name: string, args: Record<string, unknown>) =>
    mcp.client.callTool({ name, arguments: args });

  const url = opts.playgroundUrl + manifest.path;
  const outcomes: RefOutcome[] = [];

  // 重导航 + observe → pristine DOM 上的 fresh rows
  const navObserve = async (): Promise<ParsedObserve> => {
    await call("vortex_navigate", { url: "about:blank" });
    await call("vortex_navigate", { url });
    await call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });
    return parseObserveSnapshot(extractText(await call("vortex_observe", { frames })));
  };

  try {
    // 先 observe 一次拿 ref 总数 N
    const first = await navObserve();
    const total = first.rows.length;
    let truncated: string | undefined;

    for (let i = 0; i < total; i++) {
      // 每 ref 重导航 + 重 observe → pristine DOM + fresh ref(隔离 mutating click)
      const parsed = await navObserve();
      if (i >= parsed.rows.length) {
        // 重载后 ref 数缩水(理论不应,INV-1 已立):记原因,不静默截断
        truncated = `ref 数缩水: 初始 N=${total},重载后仅剩 ${parsed.rows.length} 行,中止于 i=${i}`;
        break;
      }
      const row = parsed.rows[i];
      const act = await runActProbe(call, row.ref);
      const cls = classifyAct(act);
      outcomes.push({
        ref: row.ref,
        role: row.role,
        name: row.name,
        kind: cls.kind,
        code: cls.code,
        detail: act.timedOut ? "act 超时(>5s)" : act.text.slice(0, 120),
      });
    }

    const fx = aggregateFixture(manifest.fixture, manifest.path, outcomes);
    if (truncated) fx.error = truncated;
    return fx;
  } catch (err) {
    // 中途环境/工具错误:保留已收集 outcomes,挂 error
    const fx = aggregateFixture(manifest.fixture, manifest.path, outcomes);
    fx.error = err instanceof Error ? err.message : String(err);
    return fx;
  } finally {
    await closeMcpConnection(mcp);
  }
}

/** 跑一次 vortex_act(click);reject→threw,超时→timedOut。 */
async function runActProbe(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ref: string,
): Promise<ActResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      call("vortex_act", { target: ref, action: "click" }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("__act_timeout__")), ACT_TIMEOUT_MS);
      }),
    ]);
    return { text: extractText(res), threw: false, timedOut: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: msg, threw: msg !== "__act_timeout__", timedOut: msg === "__act_timeout__" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
