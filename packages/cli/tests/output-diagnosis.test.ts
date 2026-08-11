/**
 * Author: qingwa
 * Description: CLI 遇到空结果自陈信封时，stdout 仍是原载荷，自陈走 stderr。
 *
 * stdout 是给管道用的(`vortex console logs | jq`)。自陈是给人看的,混进 stdout 会
 * 让下游 JSON 解析拿到 `{__vtxDiagnosis, value}` 而不是数组。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DIAGNOSIS_KEY } from "@vortex-browser/shared";
import { printResponse } from "../src/output.js";

function capture(fn: () => void) {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(console, "log").mockImplementation((s?: unknown) => { out.push(String(s)); });
  const se = vi.spyOn(console, "error").mockImplementation((s?: unknown) => { err.push(String(s)); });
  try { fn(); } finally { so.mockRestore(); se.mockRestore(); }
  return { out: out.join("\n"), err: err.join("\n") };
}

afterEach(() => vi.restoreAllMocks());

describe("printResponse 处理空结果自陈", () => {
  it("信封被拆开：stdout 是原载荷，stderr 是自陈", () => {
    const { out, err } = capture(() =>
      printResponse(
        { action: "console.getLogs", id: "1", result: { [DIAGNOSIS_KEY]: "buffer 刚开始录", value: [] } },
        { quiet: true },
      ),
    );
    expect(JSON.parse(out)).toEqual([]);
    expect(err).toContain("buffer 刚开始录");
  });

  it("非 quiet 模式同样拆开，result 字段回填成原载荷", () => {
    const { out, err } = capture(() =>
      printResponse(
        { action: "console.getLogs", id: "1", result: { [DIAGNOSIS_KEY]: "why", value: [] } },
        {},
      ),
    );
    expect(JSON.parse(out).result).toEqual([]);
    expect(out).not.toContain("vtxDiagnosis");
    expect(err).toContain("why");
  });

  it("没有自陈时输出逐字节不变，stderr 为空", () => {
    const payload = { action: "a", id: "1", result: [{ level: "error" }] };
    const { out, err } = capture(() => printResponse(payload, {}));
    expect(out).toBe(JSON.stringify(payload));
    expect(err).toBe("");
  });
});
