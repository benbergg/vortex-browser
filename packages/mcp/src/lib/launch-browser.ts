import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserChannels,
  launchCommand,
  NM_HOST_FILENAME,
} from "@vortex-browser/shared";

export interface BrowserHealth {
  browsers?: Array<{ label?: string; [key: string]: unknown }>;
}

interface LaunchLock {
  release(): void;
}

type AcquireLock = () => LaunchLock | true | false;
type SpawnBrowser = (cmd: string, args: string[]) => void | Promise<void>;

export interface EnsureBrowserOptions {
  pref?: string;
  lastUsed?: string;
  installed: string[];
  platform: string;
  probe?: () => Promise<BrowserHealth>;
  spawn?: SpawnBrowser;
  acquireLock?: AcquireLock;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

export function chooseBrowser(opts: {
  pref?: string;
  lastUsed?: string;
  installed: string[];
}): string | null {
  const pref = opts.pref?.trim().toLowerCase();
  if (pref) {
    const preferred = opts.installed.find((label) => label.toLowerCase().includes(pref));
    if (preferred) return preferred;
  }
  if (opts.lastUsed && opts.installed.includes(opts.lastUsed)) return opts.lastUsed;
  return opts.installed[0] ?? null;
}

export function installedBrowsers(
  home: string,
  platform: string,
  exists: (path: string) => boolean = (path) => existsSync(path),
): string[] {
  return browserChannels(home, platform)
    .filter((channel) =>
      exists(channel.profileDir) && exists(join(channel.nmDir, NM_HOST_FILENAME)))
    .map((channel) => channel.label);
}

export async function ensureBrowserRunning(
  options: EnsureBrowserOptions,
): Promise<"ready" | "launched-timeout" | "unsupported"> {
  const probe = options.probe ?? probeHealth;
  const spawn = options.spawn ?? spawnBrowser;
  const acquireLock = options.acquireLock ?? (() => acquireLaunchLock(chooseBrowser(options)));
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const first = await probe();
  if (hasBrowsers(first)) return "ready";

  const target = chooseBrowser(options);
  const command = target ? launchCommand(target, options.platform) : null;
  if (!command) return "unsupported";

  const lock = acquireLock();
  if (!lock) {
    return await waitForBrowser(probe, sleep, now, now() + timeoutMs)
      ? "ready"
      : "launched-timeout";
  }

  const release = typeof lock === "object" ? () => lock.release() : () => {};
  try {
    if (hasBrowsers(await probe())) return "ready";
    try {
      await spawn(command.cmd, command.args);
    } catch {
      return "unsupported";
    }
    return await waitForBrowser(probe, sleep, now, now() + timeoutMs)
      ? "ready"
      : "launched-timeout";
  } finally {
    release();
  }
}

async function waitForBrowser(
  probe: () => Promise<BrowserHealth>,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  deadline: number,
): Promise<boolean> {
  while (now() < deadline) {
    await sleep(Math.min(250, Math.max(0, deadline - now())));
    if (hasBrowsers(await probe())) return true;
  }
  return false;
}

function hasBrowsers(health: BrowserHealth): boolean {
  return Array.isArray(health.browsers) && health.browsers.length > 0;
}

async function probeHealth(): Promise<BrowserHealth> {
  try {
    const response = await fetch(`http://localhost:${process.env.VORTEX_PORT ?? "6800"}/health`);
    if (!response.ok) return { browsers: [] };
    return await response.json() as BrowserHealth;
  } catch {
    return { browsers: [] };
  }
}

function spawnBrowser(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(cmd, args, { detached: true, stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }
    const events = child as ChildProcess & {
      once(event: "spawn", listener: () => void): void;
      once(event: "error", listener: (error: unknown) => void): void;
    };
    events.once("spawn", () => {
      child.unref();
      resolve();
    });
    events.once("error", reject);
  });
}

function acquireLaunchLock(target: string | null): LaunchLock | false {
  if (!target) return false;
  const lockPath = join(tmpdir(), `vortex-launch-${target}.lock`);
  const token = `${process.pid}-${randomUUID()}`;
  const create = (): LaunchLock | false => {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ token, createdAt: Date.now() }));
      closeSync(fd);
      fd = undefined;
      return {
        release: () => releaseLaunchLock(lockPath, token),
      };
    } catch {
      if (fd !== undefined) closeSync(fd);
      return false;
    }
  };

  const lock = create();
  if (lock) return lock;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < 60_000) return false;
    unlinkSync(lockPath);
  } catch {
    return false;
  }
  return create();
}

function releaseLaunchLock(lockPath: string, token: string): void {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
    if (value.token === token) unlinkSync(lockPath);
  } catch {
    // 锁已被抢占或进程异常时无需再次处理
  }
}

export function defaultInstalledBrowsers(): string[] {
  return installedBrowsers(homedir(), process.platform);
}
