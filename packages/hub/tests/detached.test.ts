/**
 * Author: qingwa
 * Description: Verifies a detached hub survives termination of its launcher group.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { probeHub } from "../src/spawn.js";

describe("detached hub", () => {
  let runtime: string;
  let launcher: ChildProcess | undefined;
  let activePort: number | undefined;
  let launcherTerminated = false;
  let previousRuntime: string | undefined;

  beforeEach(async () => {
    runtime = await mkdtemp(join(tmpdir(), "vortex-hub-detached-"));
    launcherTerminated = false;
    previousRuntime = process.env.VORTEX_RUNTIME_DIR;
    process.env.VORTEX_RUNTIME_DIR = runtime;
  });

  afterEach(async () => {
    if (!launcherTerminated && launcher?.exitCode === null && launcher.pid) process.kill(-launcher.pid, "SIGTERM");
    if (launcher) await waitForExit(launcher);
    if (activePort !== undefined) await shutdownByPort(activePort);
    if (activePort !== undefined) await waitForGone(activePort);
    if (previousRuntime === undefined) delete process.env.VORTEX_RUNTIME_DIR;
    else process.env.VORTEX_RUNTIME_DIR = previousRuntime;
    await rm(runtime, { recursive: true, force: true });
  });

  it("keeps answering after the launcher process group is terminated", async () => {
    const port = await freePort();
    activePort = port;
    const loader = fileURLToPath(new URL("./fixtures/ts-loader.mjs", import.meta.url));
    const launcherFile = fileURLToPath(new URL("./fixtures/spawn-launcher.ts", import.meta.url));
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    launcher = spawn(process.execPath, [
      "--experimental-transform-types", "--experimental-loader", loader, launcherFile,
      String(port), main, loader,
    ], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, VORTEX_RUNTIME_DIR: runtime },
    });
    expect(launcher.pid).not.toBe(process.pid);
    await waitForHealth(port);
    if (!launcher.pid) throw new Error("Launcher did not expose a pid");
    process.kill(-launcher.pid, "SIGTERM");
    launcherTerminated = true;
    await waitForExit(launcher);
    expect(await probeHub(port)).not.toBeNull();
    await shutdownByPort(port);
    await waitForGone(port);
  }, 20_000);
});

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await probeHub(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Hub did not become ready");
}

async function shutdownByPort(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/hub/shutdown`, { method: "POST" }).catch(() => {});
}

async function waitForGone(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await probeHub(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Hub did not close");
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
