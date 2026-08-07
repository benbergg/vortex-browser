/**
 * Author: qingwa
 * Description: Resolves hub runtime files and the configured hub port.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function runtimeDir(): string {
  return process.env.VORTEX_RUNTIME_DIR || join(homedir(), ".vortex", "run");
}

export const hubLogPath = (port: number): string => join(runtimeDir(), `hub-${port}.log`);
export const hubPidPath = (port: number): string => join(runtimeDir(), `hub-${port}.pid`);
export const hubSpawnLockPath = (port: number): string => join(runtimeDir(), `hub-${port}.spawn.lock`);
export const agentLogPath = (pid: number): string => join(runtimeDir(), `agent-${pid}.log`);

export interface ResolveHubPortOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function resolveHubPort(options: ResolveHubPortOptions = {}): number {
  const env = options.env ?? process.env;
  const configured = parsePort(env.VORTEX_PORT);
  if (configured !== undefined) return configured;

  const home = options.home ?? homedir();
  const configPath = join(home, ".vortex", "hub.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { port?: unknown };
      const fromConfig = parsePort(config.port);
      if (fromConfig !== undefined) return fromConfig;
    } catch {
      // An invalid optional config must not prevent the default hub from starting.
    }
  }
  return 6800;
}

function parsePort(value: unknown): number | undefined {
  const port = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}
