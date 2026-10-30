// Author: qingwa
// Description: vortex MCP 自身的使用/错误遥测（JSONL 落盘）。
//
// 为什么需要它（2026-10-30 一周日志分析的结论）：
// 现在诊断 vortex 的问题只能反解各家 agent 的 transcript —— Claude Code / Pi /
// Codex 三种记录形态各不相同，脚本要跟着每家格式改；而且 transcript 里只有
// **客户端看到的东西**：服务端真实耗时、哪一层超时、页面侧到底发生了什么，
// 都取不到。上一轮为了查一次注入超时，只能在 MCP 侧加一行 stderr JSON，
// 但客户端是否留存 stderr 无人保证。
//
// 边界（重要）：
// - **不写页面内容、用户输入明文、URL、错误原文**：只写工具名、结局、错误码、
//   入参/返回的**长度**、耗时。错误原文可能含用户代码或选择器，落盘即泄露。
// - **客户端侧的 schema 校验拒绝仍然看不见**：那类失败发生在请求到达服务端之前
//   （实测 "Failed to call tool: data/tabId must be number" 一类），服务端无从知晓。
//   本 sink 覆盖的是服务端真相，不是 transcript 的替代品。
// - 写盘失败（磁盘满/权限/并发）**绝不能影响工具调用结果**：失败即静默降级。
// - 不保证崩溃场景下每次调用恰好一行；只保证正常/错误/超时/取消路径都有可解析的行。

import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageOutcome = "ok" | "error";

/**
 * 落盘字段的**外部可控性**收敛（2026-10-30 codex 复核）：
 * tool / errorCode / client 三个字段都来自外部（请求里的工具名、错误文本里的大写词、
 * 握手时客户端自报的 name/version），直接落盘会把 URL、敏感标识写进本机日志。
 * 故：工具名只认**已注册**的，错误码只认**已知**的，客户端标识只保留严格形态，
 * 其余一律归固定标识 —— 三个字段都不会原样落盘外部文本。
 */

/** 工具名：已注册才保留，否则归固定标识 */
export function sanitizeToolName(name: string, isRegistered: (n: string) => boolean): string {
  try {
    return isRegistered(name) ? name : "<unknown-tool>";
  } catch {
    return "<unknown-tool>";
  }
}

/** 错误码：只保留已知错误码白名单里的值 */
export function sanitizeErrorCode(code: string | null, known: ReadonlySet<string>): string {
  if (!code) return "UNKNOWN";
  return known.has(code) ? code : "UNKNOWN";
}

/** 客户端标识：只保留严格形态的 name@version，否则归 unknown */
export function sanitizeClientId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9._@-]{1,64}$/.test(raw) ? raw : "unknown";
}

export interface UsageRecord {
  /** ISO 时间 */
  ts: string;
  /** 工具名，如 vortex_evaluate */
  tool: string;
  outcome: UsageOutcome;
  /** vortex 错误码；成功为 null */
  errorCode: string | null;
  /** 服务端处理耗时（含 hub 往返） */
  durationMs: number;
  /** 入参 JSON 长度（不落内容） */
  argLen: number;
  /** 返回文本长度（不落内容） */
  resultLen: number;
  /** 客户端标识（name/version），取不到为 null */
  client: string | null;
  pid: number;
}

/** 默认保留天数 */
const RETENTION_DAYS = 14;
/** 连续写盘失败多少次后放弃本进程后续落盘（避免每次调用都重试坏路径） */
const MAX_FAILURES = 3;

let disabled = false;
let failures = 0;
let lastPruneDay = "";

/** 落盘目录：~/.vortex/logs（与其他 vortex 本地状态同根） */
export function usageLogDir(): string {
  return join(homedir(), ".vortex", "logs");
}

export function usageLogFile(now = new Date()): string {
  return join(usageLogDir(), `mcp-${now.toISOString().slice(0, 10)}.jsonl`);
}

/**
 * 是否开启。默认**关**（opt-in）：这是会写用户磁盘的默认行为，不该由装包替用户决定。
 * 打开方式：MCP server 进程环境变量 VORTEX_USAGE_LOG=1（或指定目录）。
 */
export function usageLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.VORTEX_USAGE_LOG;
  if (v === undefined || v === "" || v === "0" || v === "off" || v === "false") return false;
  return true;
}

/**
 * 落一行。**永不抛异常**；连续失败达上限后本进程不再尝试。
 *
 * 异步写：不能把文件系统的延迟加到工具响应上（同步 appendFileSync 会阻塞
 * MCP 事件循环）。写盘在后台完成，失败只计数，不影响调用结果。
 */
export function appendUsage(rec: UsageRecord, now = new Date()): void {
  if (disabled) return;
  const line = `${JSON.stringify(rec)}\n`;
  void (async () => {
    try {
      await pruneOldFiles(now);
      await mkdir(usageLogDir(), { recursive: true });
      await appendFile(usageLogFile(now), line, "utf8");
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= MAX_FAILURES) disabled = true;
    }
  })();
}

/** 清理过期文件（best-effort；失败不抛） */
async function pruneOldFiles(now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (day === lastPruneDay) return;
  lastPruneDay = day;
  try {
    const dir = usageLogDir();
    const cutoff = now.getTime() - RETENTION_DAYS * 86400_000;
    for (const name of await readdir(dir)) {
      if (!name.startsWith("mcp-") || !name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        const st = await stat(p);
        if (st.mtimeMs < cutoff) await unlink(p);
      } catch {
        // 单个文件删不掉不影响其他
      }
    }
  } catch {
    // 目录还不存在或读不了：下次再试
  }
}

/** 测试用：重置进程内状态 */
export function resetUsageLogState(): void {
  disabled = false;
  failures = 0;
  lastPruneDay = "";
}
