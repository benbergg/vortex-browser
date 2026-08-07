import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { spawn as nodeSpawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSupervisor } from "../src/supervisor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "fixtures", "stub-mcp-child.mjs");

/**
 * supervisor 每次热换 child 都要注入同一个 VORTEX_SESSION_ID。
 * 否则 child 重启后 sessionId 变化,hub 会当成新客户端,currentTab / browser 绑定全丢。
 */
function captureSpawnEnv() {
  const envs: NodeJS.ProcessEnv[] = [];
  const spawnFn = ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    envs.push(opts.env ?? {});
    return nodeSpawn(cmd, args, opts as Parameters<typeof nodeSpawn>[2]);
  }) as typeof nodeSpawn;
  return { envs, spawnFn };
}

function makeSupervisor(spawnFn: typeof nodeSpawn) {
  return createSupervisor({
    childEntry: STUB,
    childArgs: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    spawnFn,
    killTimeoutMs: 200,
    reinitTimeoutMs: 3000,
  });
}

describe("supervisor 注入 VORTEX_SESSION_ID", () => {
  it("首次 spawn 就带上非空 VORTEX_SESSION_ID", () => {
    const { envs, spawnFn } = captureSpawnEnv();
    const sup = makeSupervisor(spawnFn);
    try {
      sup.start();
      expect(envs).toHaveLength(1);
      expect(envs[0].VORTEX_SESSION_ID).toBeTruthy();
    } finally {
      sup.stop();
    }
  });

  it("热重启换 child 后 sessionId 不变", async () => {
    const { envs, spawnFn } = captureSpawnEnv();
    const sup = makeSupervisor(spawnFn);
    try {
      sup.start();
      sup.triggerRestart("test");
      await new Promise((r) => setTimeout(r, 1200));
      expect(envs.length).toBeGreaterThanOrEqual(2);
      // 先钉死非空,否则「两次都是 undefined」也满足「不变」
      expect(envs[0].VORTEX_SESSION_ID).toBeTruthy();
      expect(envs[envs.length - 1].VORTEX_SESSION_ID).toBe(envs[0].VORTEX_SESSION_ID);
    } finally {
      sup.stop();
    }
  }, 10000);

  it("外部已设 VORTEX_SESSION_ID 时不覆盖", () => {
    const prev = process.env.VORTEX_SESSION_ID;
    process.env.VORTEX_SESSION_ID = "outer-fixed";
    const { envs, spawnFn } = captureSpawnEnv();
    const sup = makeSupervisor(spawnFn);
    try {
      sup.start();
      expect(envs[0].VORTEX_SESSION_ID).toBe("outer-fixed");
    } finally {
      sup.stop();
      if (prev === undefined) delete process.env.VORTEX_SESSION_ID;
      else process.env.VORTEX_SESSION_ID = prev;
    }
  });
});
