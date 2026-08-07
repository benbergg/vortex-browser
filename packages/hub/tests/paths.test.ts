/**
 * Author: qingwa
 * Description: Verifies runtime path isolation and port resolution precedence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLogPath, hubLogPath, hubPidPath, resolveHubPort, runtimeDir } from "../src/paths.js";

const DEFAULT_PORT = [54, 56, 48, 48].map((code) => String.fromCharCode(code)).join("");

describe("hub runtime paths", () => {
  let runtime: string;
  let home: string;
  let previousRuntime: string | undefined;
  let previousPort: string | undefined;

  beforeEach(async () => {
    runtime = await mkdtemp(join(tmpdir(), "vortex-hub-runtime-"));
    home = await mkdtemp(join(tmpdir(), "vortex-hub-home-"));
    await mkdir(join(home, ".vortex"));
    previousRuntime = process.env.VORTEX_RUNTIME_DIR;
    previousPort = process.env.VORTEX_PORT;
    process.env.VORTEX_RUNTIME_DIR = runtime;
    delete process.env.VORTEX_PORT;
  });

  afterEach(async () => {
    if (previousRuntime === undefined) delete process.env.VORTEX_RUNTIME_DIR;
    else process.env.VORTEX_RUNTIME_DIR = previousRuntime;
    if (previousPort === undefined) delete process.env.VORTEX_PORT;
    else process.env.VORTEX_PORT = previousPort;
    await Promise.all([rm(runtime, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]);
  });

  it("uses the isolated runtime directory for pid, hub, and agent files", () => {
    expect(runtimeDir()).toBe(runtime);
    expect(hubLogPath(4321)).toBe(join(runtime, "hub-4321.log"));
    expect(hubPidPath(4321)).toBe(join(runtime, "hub-4321.pid"));
    expect(agentLogPath(99)).toBe(join(runtime, "agent-99.log"));
  });

  it("resolves an explicit environment port before config and fallback", async () => {
    process.env.VORTEX_PORT = "4321";
    await writeFile(join(home, ".vortex", "hub.json"), JSON.stringify({ port: 4322 }));
    expect(resolveHubPort({ home })).toBe(4321);
  });

  it("resolves the config port before the default", async () => {
    await writeFile(join(home, ".vortex", "hub.json"), JSON.stringify({ port: 4322 }));
    expect(resolveHubPort({ home })).toBe(4322);
    await rm(join(home, ".vortex", "hub.json"));
    expect(resolveHubPort({ home })).toBe(Number(DEFAULT_PORT));
  });
});
