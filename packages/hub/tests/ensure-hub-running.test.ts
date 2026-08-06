/**
 * Author: qingwa
 * Description: Verifies lazy hub probing, spawning, polling, and diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHubRunning } from "../src/spawn.js";

describe("ensureHubRunning", () => {
  let runtime: string;
  let previousRuntime: string | undefined;

  beforeEach(async () => {
    runtime = await mkdtemp(join(tmpdir(), "vortex-hub-spawn-"));
    previousRuntime = process.env.VORTEX_RUNTIME_DIR;
    process.env.VORTEX_RUNTIME_DIR = runtime;
  });

  afterEach(async () => {
    if (previousRuntime === undefined) delete process.env.VORTEX_RUNTIME_DIR;
    else process.env.VORTEX_RUNTIME_DIR = previousRuntime;
    await rm(runtime, { recursive: true, force: true });
  });

  it("does not spawn when the first probe finds a live hub", async () => {
    let spawned = 0;
    const result = await ensureHubRunning({
      port: 4321,
      role: "test",
      probe: async () => ({ status: "ok" }),
      spawnFn: () => { spawned += 1; },
    });

    expect(result).toEqual({ status: "ok" });
    expect(spawned).toBe(0);
  });

  it("spawns once and polls until the hub is ready", async () => {
    let probes = 0;
    let spawned = 0;
    const result = await ensureHubRunning({
      port: 4321,
      role: "test",
      probe: async () => {
        probes += 1;
        return probes < 3 ? null : { status: "ok", ready: true };
      },
      spawnFn: () => { spawned += 1; },
      sleep: async () => {},
    });

    expect(result).toEqual({ status: "ok", ready: true });
    expect(spawned).toBe(1);
    expect(probes).toBe(3);
  });

  it("includes the hub log path when readiness times out", async () => {
    await expect(ensureHubRunning({
      port: 4321,
      role: "test",
      probe: async () => null,
      spawnFn: () => {},
      sleep: async () => {},
      timeoutMs: 0,
    })).rejects.toThrow(/hub-4321\.log/);
  });
});
