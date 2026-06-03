// packages/vortex-bench/tests/snapshot-parse.test.ts
// 回归锁:snapshot 序列化结果解析 + 截断检测(2026-06-03 大公开站冻结调查)。
//
// 根因:vortex_evaluate 响应经 MCP RESPONSE_SIZE_LIMIT(默认 100KB)截断时,会在
// JSON 字符串字面量中间插入 "\n\n[TRUNCATED: ...]",JSON.parse 报 "Bad control
// character in string literal at position 100000" —— 误导性极强。修复两路:① bench
// 给自己的 MCP 设高 VORTEX_RESPONSE_SIZE_LIMIT(程序化客户端不进 agent 上下文);
// ② 仍检测 [TRUNCATED 标记,明确报"被截断"而非含糊的 JSON 语法错。

import { describe, it, expect } from "vitest";
import { parseSerializeResult } from "../src/runner/snapshot.js";

describe("parseSerializeResult", () => {
  it("合法 JSON → 返回 SerializeResult", () => {
    const raw = JSON.stringify({ html: "<!doctype html><html></html>", candidates: [] });
    const ser = parseSerializeResult(raw);
    expect(ser.html).toContain("doctype");
    expect(ser.candidates).toEqual([]);
  });

  it("含 [TRUNCATED 标记 → 明确报截断(非含糊 JSON 错)", () => {
    const truncated =
      '{\n  "html": "<div>aaaa' + "a".repeat(50) +
      '\n\n[TRUNCATED: response was 250000 bytes, showing first 100000. Use filter/pagination parameters for smaller responses.]';
    expect(() => parseSerializeResult(truncated)).toThrow(/截断|TRUNCATED/);
    // 不应抛出含糊的 "Bad control character" 而不提截断
    try {
      parseSerializeResult(truncated);
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/截断|TRUNCATED/);
    }
  });

  it("非截断的非法 JSON → 报「非合法 JSON」", () => {
    expect(() => parseSerializeResult("{not json")).toThrow(/非合法 JSON/);
  });
});
