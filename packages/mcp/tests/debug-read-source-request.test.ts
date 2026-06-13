/**
 * TDD: vortex_debug_read source="request" MCP dispatch 路由
 *
 * 覆盖场景:
 *   ① source=request + reqid → 路由到 network.getRequestDetail
 *   ② source=request 缺 reqid → 报 INVALID_PARAMS
 *   ③ source=console 不回归
 *   ④ source=network 不回归(仍须 pattern)
 *   ⑤ source=request 在 schemas-public.ts 中被声明为有效 enum 值
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dispatchNewTool } from "../src/tools/dispatch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SRC = readFileSync(
  join(__dirname, "..", "src", "tools", "schemas-public.ts"),
  "utf8",
);

describe("vortex_debug_read source=request dispatch (TDD)", () => {
  it("① source=request + reqid → 路由到 network.getRequestDetail", () => {
    const r = dispatchNewTool("vortex_debug_read", {
      source: "request",
      reqid: "req-001",
    });
    expect(r?.action).toBe("network.getRequestDetail");
    expect(r?.params.requestId).toBe("req-001");
  });

  it("② source=request 缺 reqid → 抛 INVALID_PARAMS", () => {
    expect(() =>
      dispatchNewTool("vortex_debug_read", { source: "request" }),
    ).toThrow(/reqid.*required|INVALID_PARAMS/i);
  });

  it("③ source=console 不回归 → console.getLogs", () => {
    const r = dispatchNewTool("vortex_debug_read", { source: "console" });
    expect(r?.action).toBe("console.getLogs");
  });

  it("④ source=network 不回归(仍须 pattern) → 抛错", () => {
    expect(() =>
      dispatchNewTool("vortex_debug_read", { source: "network" }),
    ).toThrow(/pattern.*required/i);
  });

  it("④b source=network + pattern → network.getLogs", () => {
    const r = dispatchNewTool("vortex_debug_read", {
      source: "network",
      pattern: "/api/",
    });
    expect(r?.action).toBe("network.getLogs");
  });
});

describe("schemas-public.ts source enum 包含 'request'", () => {
  it("⑤ vortex_debug_read source enum 含 'request'", () => {
    // 检查 source enum 定义包含 "request"
    expect(SCHEMA_SRC).toMatch(/"request"/);
  });

  it("⑤b vortex_debug_read schema 含 reqid 字段", () => {
    expect(SCHEMA_SRC).toMatch(/reqid/);
  });
});
