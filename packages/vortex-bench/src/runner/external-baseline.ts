// 外部基线对照：同一组页面，vortex 与 chrome-devtools-mcp 各观察一次，比输出字节与耗时。
//
// 动机:vortex 长期只用自家 bench 自证,历史上多次"自闭环判断→假绿"。官方
// chrome-devtools-mcp 是可得的外部锚点。
//
// 但两边浏览器不是同一个(vortex 接管真实已登录 Edge/Chrome,chrome-devtools-mcp
// 自启隔离实例),任何数字都不能当 parity 引用 —— 故 summarize 恒带 caveat。
import { createMcpConnection, closeMcpConnection } from "./mcp-client.js";

export interface BaselineSample {
  tool: string;
  page: string;
  bytes: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ToolSummary {
  pages: number;
  failures: number;
  totalBytes: number;
  avgDurationMs: number;
}

export interface BaselineSummary {
  tools: Record<string, ToolSummary>;
  caveat: string;
}

export const CAVEAT =
  "环境不对等：vortex 接管真实已登录浏览器，chrome-devtools-mcp 使用自启隔离实例。" +
  "字节与耗时仅供量级参考，不构成 parity（not comparable as parity）。";

export function summarize(samples: BaselineSample[]): BaselineSummary {
  const tools: Record<string, ToolSummary> = {};
  for (const s of samples) {
    const t = (tools[s.tool] ??= { pages: 0, failures: 0, totalBytes: 0, avgDurationMs: 0 });
    t.pages++;
    if (!s.ok) {
      t.failures++;
      continue;
    }
    t.totalBytes += s.bytes;
    t.avgDurationMs += s.durationMs;
  }
  for (const t of Object.values(tools)) {
    const ok = t.pages - t.failures;
    t.avgDurationMs = ok > 0 ? Math.round(t.avgDurationMs / ok) : 0;
  }
  return { tools, caveat: CAVEAT };
}

type Conn = Awaited<ReturnType<typeof createMcpConnection>>;

function textBytes(res: unknown): number {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item) {
      n += Buffer.byteLength(String((item as { text: unknown }).text), "utf-8");
    }
  }
  return n;
}

async function sample(
  cfg: { command: string; args: string[] },
  tool: string,
  page: string,
  observe: (conn: Conn, page: string) => Promise<unknown>,
): Promise<BaselineSample> {
  const started = Date.now();
  let conn: Conn | undefined;
  try {
    conn = await createMcpConnection({ ...cfg, env: { ...(process.env as Record<string, string>) } });
    const res = await observe(conn, page);
    return { tool, page, bytes: textBytes(res), durationMs: Date.now() - started, ok: true };
  } catch (e) {
    return {
      tool, page, bytes: 0, durationMs: Date.now() - started, ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (conn) await closeMcpConnection(conn);
  }
}

/**
 * 跑一轮对照。mcpBin 是 vortex MCP 的入口脚本路径（与 run-case 同一真值源）。
 */
export async function runExternalBaseline(pages: string[], mcpBin: string): Promise<BaselineSample[]> {
  const vortex = { command: process.execPath, args: [mcpBin] };
  // --no-usage-statistics: 该 server 默认开启向 Google 上报,基线跑不该顺带上报
  const cdt = {
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@1.7.0", "--headless=true", "--isolated=true", "--no-usage-statistics"],
  };

  const out: BaselineSample[] = [];
  for (const page of pages) {
    out.push(await sample(vortex, "vortex", page, async (conn, p) => {
      await conn.client.callTool({ name: "vortex_navigate", arguments: { url: p, waitUntil: "load" } });
      return conn.client.callTool({ name: "vortex_observe", arguments: {} });
    }));
    out.push(await sample(cdt, "chrome-devtools-mcp", page, async (conn, p) => {
      await conn.client.callTool({ name: "new_page", arguments: { url: p } });
      return conn.client.callTool({ name: "take_snapshot", arguments: {} });
    }));
  }
  return out;
}
