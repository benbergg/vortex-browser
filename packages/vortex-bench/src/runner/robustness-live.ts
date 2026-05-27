// packages/vortex-bench/src/runner/robustness-live.ts
// #3.x live 真站健壮性探测编排(需活 MCP)。严格只读 extract + settle + 二次确认。
// 见设计 §2/§3。无离线单测,靠 live 验收。

import { createMcpConnection, closeMcpConnection } from "./mcp-client.js";
import { parseObserveSnapshot } from "./observe-parser.js";
import { classifyAct, type ActResult } from "./robustness-classify.js";
import { aggregateFixture, CONTRACT_VIOLATION_CODES } from "./robustness-aggregate.js";
import { confirmContractViolations, refIdentity } from "./robustness-confirm.js";
import type { FixtureRobustness, RefOutcome } from "../robustness-types.js";

export interface LiveTarget {
  /** navigate 到此 URL 再探;与 currentTab 二选一 */
  url?: string;
  /** 探当前已加载/已登录 tab(不导航) */
  currentTab?: boolean;
}

export interface RobustnessLiveOptions {
  mcpBin: string;
}

const EXTRACT_TIMEOUT_MS = 5000;

function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((i) => i && typeof i === "object" && "text" in i)
    .map((i) => String((i as { text: unknown }).text))
    .join("\n");
}

function isContractViolation(o: RefOutcome): boolean {
  return o.kind === "typed-error" && o.code !== null && CONTRACT_VIOLATION_CODES.has(o.code);
}

export async function probeLive(
  target: LiveTarget,
  opts: RobustnessLiveOptions,
): Promise<FixtureRobustness> {
  const fixtureName = target.url ?? "current-tab";
  const mcp = await createMcpConnection({
    command: process.execPath,
    args: [opts.mcpBin],
    env: { ...(process.env as Record<string, string>) },
  });
  const call = (name: string, args: Record<string, unknown>) =>
    mcp.client.callTool({ name, arguments: args });

  const outcomes: RefOutcome[] = [];

  const probe = async (ref: string, role: string, name: string | null): Promise<RefOutcome> => {
    // extract 经 content.getText:解析不到 → 干净抛 Error[ELEMENT_NOT_FOUND](content.ts:175);
    // 成功 → {text,controls}(无 Error)。故 classifyAct(解析 Error 文本)即可:not-found→typed-error
    // ELEMENT_NOT_FOUND(R0),success→ok。无需 null-result 检测(extract 不静默返 null)。
    const raw = await runExtractProbe(call, ref);
    const cls = classifyAct(raw);
    return {
      ref,
      role,
      name,
      kind: cls.kind,
      code: cls.code,
      detail: raw.timedOut ? "extract 超时(>5s)" : raw.text.slice(0, 120),
    };
  };

  try {
    // Pass 1: navigate(可选)→ settle → observe S1 → 逐 ref extract
    if (target.url) {
      await call("vortex_navigate", { url: "about:blank" });
      await call("vortex_navigate", { url: target.url });
    }
    await call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });
    const s1 = parseObserveSnapshot(extractText(await call("vortex_observe", {})));
    for (const row of s1.rows) {
      outcomes.push(await probe(row.ref, row.role, row.name));
    }

    const pass1Failures = outcomes.filter(isContractViolation);

    let finalOutcomes = outcomes;
    if (pass1Failures.length > 0) {
      // Pass 2: settle → 重 observe S2 → 对失败身份的 S2 行重 extract → 二次确认
      await call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 5000 });
      const s2 = parseObserveSnapshot(extractText(await call("vortex_observe", {})));
      const failedIds = new Set(pass1Failures.map((f) => refIdentity(f.role, f.name)));
      const pass2 = new Map<string, RefOutcome[]>();
      for (const row of s2.rows) {
        const id = refIdentity(row.role, row.name);
        if (!failedIds.has(id)) continue;
        const oc = await probe(row.ref, row.role, row.name);
        const arr = pass2.get(id) ?? [];
        arr.push(oc);
        pass2.set(id, arr);
      }
      const confirmed = confirmContractViolations(pass1Failures, pass2);
      const confirmedRefs = new Set(confirmed.map((c) => c.ref));
      // 丢弃未确认的 pass1 失败(抖动);保留 ok + R1 + 确认的 R0
      finalOutcomes = outcomes.filter((o) => !isContractViolation(o) || confirmedRefs.has(o.ref));
    }

    return aggregateFixture(fixtureName, fixtureName, finalOutcomes);
  } catch (err) {
    const fx = aggregateFixture(fixtureName, fixtureName, outcomes);
    fx.error = err instanceof Error ? err.message : String(err);
    return fx;
  } finally {
    await closeMcpConnection(mcp);
  }
}

/** 跑一次只读 vortex_extract;reject→threw,超时→timedOut。 */
async function runExtractProbe(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ref: string,
): Promise<ActResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      call("vortex_extract", { target: ref, include: ["attrs"] }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("__extract_timeout__")), EXTRACT_TIMEOUT_MS);
      }),
    ]);
    return { text: extractText(res), threw: false, timedOut: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: msg, threw: msg !== "__extract_timeout__", timedOut: msg === "__extract_timeout__" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
