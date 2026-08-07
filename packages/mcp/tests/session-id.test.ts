import { describe, it, expect } from "vitest";
import { resolveSessionId } from "../src/lib/session-id.js";

const base = { ppid: 4321, cwd: "/repo/a", env: {} as NodeJS.ProcessEnv };

describe("resolveSessionId", () => {
  it("VORTEX_SESSION_ID 最高优先级,原样返回", () => {
    const id = resolveSessionId({ ...base, env: { VORTEX_SESSION_ID: "my-session" } });
    expect(id).toBe("my-session");
  });

  it("VORTEX_SESSION_ID 压过 VORTEX_SESSION_NAME", () => {
    const id = resolveSessionId({
      ...base,
      env: { VORTEX_SESSION_ID: "explicit", VORTEX_SESSION_NAME: "named" },
    });
    expect(id).toBe("explicit");
  });

  it("空白 VORTEX_SESSION_ID 不生效,退回派生值", () => {
    const blank = resolveSessionId({ ...base, env: { VORTEX_SESSION_ID: "   " } });
    expect(blank).toBe(resolveSessionId(base));
  });

  // 关键不变式:MCP 自重启(exit 0 → 客户端 respawn)后 ppid 不变,
  // session 必须原样复用,否则 currentTab / browser 绑定全丢。
  it("同 ppid + 同 cwd 恒等,跨进程重启保持不变", () => {
    expect(resolveSessionId(base)).toBe(resolveSessionId({ ...base }));
  });

  it("ppid 不同则 id 不同", () => {
    expect(resolveSessionId({ ...base, ppid: 1 })).not.toBe(resolveSessionId({ ...base, ppid: 2 }));
  });

  it("cwd 不同则 id 不同:两个 worktree 各自独立 session", () => {
    expect(resolveSessionId({ ...base, cwd: "/repo/a" })).not.toBe(
      resolveSessionId({ ...base, cwd: "/repo/b" }),
    );
  });

  it("VORTEX_SESSION_NAME 不同则 id 不同:同目录也能开两路", () => {
    expect(resolveSessionId({ ...base, env: { VORTEX_SESSION_NAME: "x" } })).not.toBe(
      resolveSessionId({ ...base, env: { VORTEX_SESSION_NAME: "y" } }),
    );
  });

  it("派生值形如 mcp-<12 位 hex>,不泄露 cwd 明文", () => {
    const id = resolveSessionId({ ...base, cwd: "/Users/secret/project" });
    expect(id).toMatch(/^mcp-[0-9a-f]{12}$/);
    expect(id).not.toContain("secret");
  });
});
