import { createHash } from "node:crypto";

export interface SessionIdInput {
  env: NodeJS.ProcessEnv;
  /** 父进程 pid：MCP 自重启后由客户端 respawn，ppid 不变，session 才粘得住 */
  ppid: number;
  cwd: string;
}

/**
 * 解析本 MCP 客户端的稳定 sessionId。
 *
 * 派生自 ppid + cwd + VORTEX_SESSION_NAME 而非随机值：hub 靠它区分并发客户端，
 * 值一变就等于换了个客户端，currentTab 与 browser 绑定全丢。
 */
export function resolveSessionId(input: SessionIdInput): string {
  const explicit = input.env.VORTEX_SESSION_ID?.trim();
  if (explicit) return explicit;

  const name = input.env.VORTEX_SESSION_NAME?.trim() ?? "";
  const digest = createHash("sha256")
    .update(`${input.ppid}|${input.cwd}|${name}`)
    .digest("hex");
  return `mcp-${digest.slice(0, 12)}`;
}

/** 生产入口：读当前进程的 ppid/cwd/env。 */
export function currentSessionId(): string {
  return resolveSessionId({ env: process.env, ppid: process.ppid, cwd: process.cwd() });
}
