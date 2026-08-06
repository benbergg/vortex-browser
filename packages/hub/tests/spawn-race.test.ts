/**
 * Author: qingwa
 * Description: Verifies listen-as-lock with a real five-process race runner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

describe("hub listen race", () => {
  let runtime: string;
  let runner: ChildProcess | undefined;
  let previousRuntime: string | undefined;

  beforeEach(async () => {
    runtime = await mkdtemp(join(tmpdir(), "vortex-hub-race-"));
    previousRuntime = process.env.VORTEX_RUNTIME_DIR;
    process.env.VORTEX_RUNTIME_DIR = runtime;
  });

  afterEach(async () => {
    if (runner) await waitForClose(runner);
    if (previousRuntime === undefined) delete process.env.VORTEX_RUNTIME_DIR;
    else process.env.VORTEX_RUNTIME_DIR = previousRuntime;
    await rm(runtime, { recursive: true, force: true });
  });

  it("leaves one stable pid and four clean exit(0) losers", async () => {
    const loader = fileURLToPath(new URL("./fixtures/ts-loader.mjs", import.meta.url));
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const runnerFile = fileURLToPath(new URL("./fixtures/spawn-race-runner.mjs", import.meta.url));
    runner = spawn(process.execPath, [runnerFile, loader, main], {
      env: { ...process.env, VORTEX_RUNTIME_DIR: runtime },
      stdio: ["ignore", "pipe", "pipe"],
    });
    runner.stdout?.resume();
    runner.stderr?.resume();
    const exit = await waitForClose(runner);
    const result = JSON.parse(await readFile(join(runtime, "race-result.json"))) as {
      stablePid: number;
      children: Array<{ pid: number; exitCode: number | null; signal: string | null }>;
    };

    expect(exit.code).toBe(0);
    expect(result.children).toHaveLength(5);
    expect(result.children.filter((child) => child.pid !== result.stablePid)).toHaveLength(4);
    expect(result.children.filter((child) => child.pid !== result.stablePid).every((child) => child.exitCode === 0)).toBe(true);
  }, 60_000);
});

function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
