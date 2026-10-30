/**
 * Author: qingwa
 * Description: Verifies the MCP usage-log sink (JSONL, no content, never throws).
 *
 * 2026-10-30 一周日志分析引入：诊断不再依赖反解 agent transcript。
 * 2026-10-30 codex 复核后收紧：写盘路径必须真的被挡住（上一版测的是 $HOME/logs，
 * 而实现写的是 $HOME/.vortex/logs，测试其实没制造失败）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsage,
  resetUsageLogState,
  sanitizeClientId,
  sanitizeErrorCode,
  sanitizeToolName,
  usageLogEnabled,
  usageLogFile,
  type UsageRecord,
} from "../src/usage-log.js";

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  ts: new Date().toISOString(),
  tool: "vortex_evaluate",
  outcome: "ok",
  errorCode: null,
  durationMs: 1234,
  argLen: 42,
  resultLen: 2048,
  client: "claude-code@1.0.0",
  pid: 1234,
  ...over,
});

// 异步落盘：等一小会儿让写盘完成
const settle = () => new Promise((r) => setTimeout(r, 120));

describe("mcp usage log", () => {
  let home: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    resetUsageLogState();
    home = mkdtempSync(join(tmpdir(), "vortex-usage-log-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("默认关闭（opt-in）", () => {
    expect(usageLogEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(usageLogEnabled({ VORTEX_USAGE_LOG: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(usageLogEnabled({ VORTEX_USAGE_LOG: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("落一行可解析 JSON，且不包含内容字段", async () => {
    appendUsage(rec(), new Date("2026-10-30T10:00:00Z"));
    await settle();
    const file = join(home, ".vortex", "logs", "mcp-2026-10-30.jsonl");
    const line = readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(line) as UsageRecord;
    expect(parsed.tool).toBe("vortex_evaluate");
    expect(parsed.durationMs).toBe(1234);
    // 只记长度，不记内容
    expect(Object.keys(parsed).sort()).toEqual([
      "argLen",
      "client",
      "durationMs",
      "errorCode",
      "outcome",
      "pid",
      "resultLen",
      "tool",
      "ts",
    ]);
  });

  it("写盘失败不抛（真正挡住 .vortex/logs 路径时静默降级）", async () => {
    // 造一个同名文件占住 .vortex/logs → mkdir 会失败（ENOTDIR）
    mkdirSync(join(home, ".vortex"), { recursive: true });
    writeFileSync(join(home, ".vortex", "logs"), "not a dir");
    expect(() => appendUsage(rec(), new Date())).not.toThrow();
    await settle();
    // 连续失败也不抛（达到上限后放弃本进程后续落盘）
    expect(() => appendUsage(rec(), new Date())).not.toThrow();
    expect(() => appendUsage(rec(), new Date())).not.toThrow();
    expect(() => appendUsage(rec(), new Date())).not.toThrow();
    await settle();
  });

  it("保留期：超过 14 天的文件被清掉", async () => {
    const dir = join(home, ".vortex", "logs");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "mcp-2026-09-01.jsonl");
    writeFileSync(old, "{}\n");
    const oldTime = new Date("2026-09-01T00:00:00Z");
    // 把旧文件的 mtime 调到保留期之外
    utimesSync(old, oldTime, oldTime);

    appendUsage(rec(), new Date("2026-10-30T10:00:00Z"));
    await settle();
    expect(() => readFileSync(old, "utf8")).toThrow();
    expect(readFileSync(join(dir, "mcp-2026-10-30.jsonl"), "utf8").trim().length).toBeGreaterThan(0);
  });

  it("文件名按日切分", () => {
    expect(usageLogFile(new Date("2026-10-30T23:59:59Z")).endsWith("mcp-2026-10-30.jsonl")).toBe(true);
  });
});

describe("落盘字段的外部可控性收敛", () => {
  it("工具名只保留已注册的，未注册的（含外部塞进来的 URL）归固定标识", () => {
    const registered = (n: string) => n === "vortex_evaluate";
    expect(sanitizeToolName("vortex_evaluate", registered)).toBe("vortex_evaluate");
    expect(sanitizeToolName("https://example.com/?token=abc", registered)).toBe("<unknown-tool>");
    expect(sanitizeToolName("", registered)).toBe("<unknown-tool>");
  });

  it("错误码只保留白名单内的，其余归 UNKNOWN", () => {
    const known = new Set(["TIMEOUT", "TAB_NOT_FOUND"]);
    expect(sanitizeErrorCode("TIMEOUT", known)).toBe("TIMEOUT");
    expect(sanitizeErrorCode("SYNTHETIC_URL_TOKEN", known)).toBe("UNKNOWN");
    expect(sanitizeErrorCode(null, known)).toBe("UNKNOWN");
  });

  it("客户端标识只保留严格形态的 name@version", () => {
    expect(sanitizeClientId("claude-code@1.0.0")).toBe("claude-code@1.0.0");
    expect(sanitizeClientId("https://example.com/?token=abc")).toBe("unknown");
    expect(sanitizeClientId(undefined)).toBeNull();
  });
});
