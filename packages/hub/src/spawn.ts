/**
 * Author: qingwa
 * Description: Probes, lazily spawns, and polls for the hub process.
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";
import { hubLogPath, hubSpawnLockPath, runtimeDir } from "./paths.js";

export interface HubProbe {
  status: string;
  [key: string]: unknown;
}

export interface EnsureHubOptions {
  port: number;
  role: string;
  probe?: (port: number) => Promise<HubProbe | null>;
  spawnFn?: () => void;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export interface TrySpawnHubOptions {
  port: number;
  role: string;
  hubEntry?: string;
  nodeArgs?: string[];
  spawnFn?: SpawnFn;
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export async function probeHub(port: number, timeoutMs = 300): Promise<HubProbe | null> {
  return new Promise((resolve) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/health", method: "GET", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(body) as HubProbe;
          resolve(parsed.status === "ok" ? parsed : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

export async function ensureHubRunning(options: EnsureHubOptions): Promise<HubProbe> {
  const probe = options.probe ?? probeHub;
  const spawnFn = options.spawnFn ?? (() => { trySpawnHub({ port: options.port, role: options.role }); });
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const first = await probe(options.port);
  if (first) return first;
  spawnFn();

  let elapsed = 0;
  let delay = 50;
  while (elapsed < timeoutMs) {
    await sleep(Math.min(delay, timeoutMs - elapsed));
    elapsed += delay;
    const ready = await probe(options.port);
    if (ready) return ready;
    delay = Math.min(delay * 2, 400);
  }
  throw vtxError(VtxErrorCode.TIMEOUT, `Hub did not become ready; see ${hubLogPath(options.port)}`);
}

export function trySpawnHub(options: TrySpawnHubOptions): ChildProcess | undefined {
  mkdirSync(runtimeDir(), { recursive: true });
  const lock = hubSpawnLockPath(options.port);
  const fd = acquireSpawnLock(lock);
  if (fd === undefined) return undefined;

  const logFd = openSync(hubLogPath(options.port), "a");
  const entry = options.hubEntry ?? fileURLToPath(new URL("./main.js", import.meta.url));
  const childArgs = [...(options.nodeArgs ?? []), entry, "--port", String(options.port)];
  try {
    const child = (options.spawnFn ?? nodeSpawn)(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, VORTEX_HUB_SPAWNED_BY: options.role },
    });
    child.unref();
    return child;
  } catch (error) {
    try { unlinkSync(lock); } catch { /* best effort */ }
    throw error;
  } finally {
    closeSync(logFd);
    closeSync(fd);
  }
}

function acquireSpawnLock(lock: string): number | undefined {
  try {
    const fd = openSync(lock, "wx");
    writeFileSync(fd, `${process.pid}`);
    return fd;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs >= 10_000) {
        unlinkSync(lock);
        const fd = openSync(lock, "wx");
        writeFileSync(fd, `${process.pid}`);
        return fd;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
