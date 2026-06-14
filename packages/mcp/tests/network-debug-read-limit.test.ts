import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dispatchNewTool } from "../src/tools/dispatch.js";

/**
 * TDD: vortex_debug_read source=network 必须有 pattern (B3-8, v3.1 P2).
 *
 * Background: network 走 `network.getLogs`, 内部 hard cap MAX_API_LOGS=5000
 * (network.ts:29). 即便有上限, 误用 source=network 不带 pattern 仍会拉
 * 所有历史请求, 一次吃 ~5K tokens. 让 dispatcher 强制 pattern 是低成本
 * 防护 + 显式引导 LLM 主动筛选.
 *
 * Fix: dispatcher + description 都加上 "pattern REQUIRED for network" 提示.
 *   - source=console 不受此约束 (console.getLogs 无 pattern 概念)
 *   - pattern 接受 top-level `pattern` 或 `filter.pattern` 两种形式
 *   - pattern 是空字符串也算无效 (避免 pattern="" 误用)
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SRC = readFileSync(
  join(__dirname, "..", "src", "tools", "schemas-public.ts"),
  "utf8",
);

function getDebugReadDescription(): string {
  const m = SCHEMA_SRC.match(
    /name:\s*["']vortex_debug_read["'][\s\S]*?description:\s*([\s\S]*?),\s*schema:\s*\{/,
  );
  expect(m, "vortex_debug_read description block").not.toBeNull();
  return m![1]
    .replace(/"\s*\+\s*"/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

describe("vortex_debug_read dispatcher: source=network 强制 pattern (B3-8, v3.1)", () => {
  it("source=network 无 pattern 应抛 INVALID_PARAMS (B3-8 关键)", () => {
    expect(() => dispatchNewTool("vortex_debug_read", { source: "network" }))
      .toThrow(/pattern.*required|pattern.*empty/i);
  });

  it("source=network + pattern='' (空字符串) 抛 INVALID_PARAMS", () => {
    expect(() => dispatchNewTool("vortex_debug_read", { source: "network", pattern: "" }))
      .toThrow(/pattern.*required|pattern.*empty/i);
  });

  it("source=network + filter={pattern:''} (filter 内空字符串) 抛 INVALID_PARAMS", () => {
    expect(() =>
      dispatchNewTool("vortex_debug_read", { source: "network", filter: { pattern: "" } }),
    ).toThrow(/pattern.*required|pattern.*empty/i);
  });

  it("source=network + pattern='/api/' 正常透传", () => {
    const r = dispatchNewTool("vortex_debug_read", { source: "network", pattern: "/api/" });
    expect(r?.action).toBe("network.getLogs");
    expect(r?.params.pattern).toBe("/api/");
  });

  it("source=network + filter={pattern:'/api/'} 正常透传 (filter 形式)", () => {
    const r = dispatchNewTool("vortex_debug_read", {
      source: "network",
      filter: { pattern: "/api/" },
    });
    expect(r?.action).toBe("network.getLogs");
  });

  it("source=console 不要求 pattern (旧行为不变, 回归保护)", () => {
    const r = dispatchNewTool("vortex_debug_read", { source: "console" });
    expect(r?.action).toBe("console.getLogs");
  });

  it("source=console + 空 filter 也接受 (console 无 pattern 概念)", () => {
    const r = dispatchNewTool("vortex_debug_read", { source: "console", filter: {} });
    expect(r?.action).toBe("console.getLogs");
  });
});

describe("vortex_debug_read description 文档化 (B3-8, v3.1)", () => {
  it("description 含 'pattern REQUIRED' 提示 (B3-8 关键)", () => {
    const desc = getDebugReadDescription();
    expect(desc).toMatch(/pattern.*required|required.*pattern/i);
  });

  it("description 总长度 ≤ 180 char (I15 invariant 约束, source=request 能力追加后放宽至 v5.0 上限)", () => {
    const desc = getDebugReadDescription();
    // I15 v5.0 全局上限 180 char; source=request 新能力将 description 扩至 ~76 char
    expect(desc.length).toBeLessThanOrEqual(180);
  });
});
