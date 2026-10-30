// 抽取器 fixture 单测:node --test scripts/usage-baseline/
//
// 抽取器算错,整周结论就作废。这里覆盖的是最容易出错的边界:
// 乱序结果、缺结果、重复块、嵌套调用、非 vortex 工具、代理/直连两种命名。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeFile,
  parsePiFile,
  parseCodexFile,
  parseSinkFile,
  buildFacts,
  reduceFacts,
  normalizeToolName,
  errorCode,
  isEmptySuccess,
} from "./extract.mjs";

const line = (o) => JSON.stringify(o);

test("normalizeToolName: 代理形态 / 直连形态 / 非 vortex", () => {
  assert.equal(normalizeToolName("mcp__vortex", { tool: "vortex_evaluate" }), "evaluate");
  assert.equal(normalizeToolName("mcp__vortex__vortex_observe", null), "observe");
  assert.equal(normalizeToolName("mcp__playwright__browser_navigate", null), null);
  assert.equal(normalizeToolName("bash", null), null);
});

test("claude: 配对成功 / 错误 / 非 vortex 工具 / 无调用结果", () => {
  const text = [
    line({ timestamp: "2026-10-30T10:00:00Z", sessionId: "s1", cwd: "/p", message: { content: [
      { type: "tool_use", id: "c1", name: "mcp__vortex__vortex_evaluate", input: { code: "1" } },
      { type: "tool_use", id: "c2", name: "mcp__vortex__vortex_act", input: { target: "x" } },
      { type: "tool_use", id: "c3", name: "mcp__playwright__browser_navigate", input: {} },
    ] } }),
    line({ timestamp: "2026-10-30T10:00:02Z", sessionId: "s1", cwd: "/p", message: { content: [
      { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "ok-result" }] },
      { type: "tool_result", tool_use_id: "c2", is_error: true, content: [{ type: "text", text: "Error [TIMEOUT]: js.evaluate timed out after 5000ms" }] },
      { type: "tool_result", tool_use_id: "c3", content: [{ type: "text", text: "pw" }] },
    ] } }),
  ].join("\n");

  const p = parseClaudeFile(text, "/tmp/a.jsonl");
  assert.equal(p.calls.length, 2, "playwright 调用不算 vortex");
  assert.equal(p.results.length, 2, "playwright 的 result 不配对进 vortex");

  const facts = buildFacts([p]);
  assert.equal(facts.length, 2);
  const evalFact = facts.find((f) => f.tool === "evaluate");
  assert.equal(evalFact.outcome, "ok");
  assert.equal(evalFact.durationMs, 2000);
  const actFact = facts.find((f) => f.tool === "act");
  assert.equal(actFact.outcome, "error");
  assert.equal(actFact.errorCode, "TIMEOUT");
  assert.match(actFact.errorSig, /TIMEOUT/);
});

test("claude: 结果先于调用出现(乱序)也能配对", () => {
  const text = [
    line({ timestamp: "2026-10-30T10:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "r" }] }] } }),
    line({ timestamp: "2026-10-30T10:00:00Z", message: { content: [{ type: "tool_use", id: "c1", name: "mcp__vortex__vortex_observe", input: {} }] } }),
  ].join("\n");
  const facts = buildFacts([parseClaudeFile(text, "/tmp/a.jsonl")]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].outcome, "ok");
});

test("pi: 代理形态 toolCall + toolResult 配对,嵌套调用不双计", () => {
  const text = [
    line({ type: "message", timestamp: "2026-10-30T10:00:00Z", message: { role: "assistant", content: [
      { type: "toolCall", id: "call_1", name: "mcp__vortex", arguments: { tool: "vortex_evaluate", args: { code: "1" } } },
    ] } }),
    line({ type: "message", timestamp: "2026-10-30T10:00:01Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "mcp__vortex", isError: false, durationMs: 660, content: [{ type: "text", text: "res" }], nestedCalls: { calls: [{ id: "call_1/1", name: "mcp__vortex__vortex_evaluate", status: "ok", arguments: {}, durationMs: 323 }], complete: true } } }),
  ].join("\n");
  const p = parsePiFile(text, "/tmp/s.jsonl");
  assert.equal(p.calls.length, 1);
  const facts = buildFacts([p]);
  assert.equal(facts.length, 1, "嵌套调用不另计一条");
  assert.equal(facts[0].outcome, "ok");
  assert.equal(facts[0].durationMs, 660);
  assert.equal(facts[0].tool, "evaluate");
});

test("pi: 直连形态 mcp__vortex__vortex_x 也能识别", () => {
  const text = [
    line({ type: "message", timestamp: "2026-10-30T10:00:00Z", message: { role: "assistant", content: [
      { type: "toolCall", id: "call_9", name: "mcp__vortex__vortex_extract", arguments: {} },
    ] } }),
    line({ type: "message", timestamp: "2026-10-30T10:00:01Z", message: { role: "toolResult", toolCallId: "call_9", toolName: "mcp__vortex__vortex_extract", isError: true, content: [{ type: "text", text: "Error [TAB_NOT_FOUND]: No tab with id: 1" }] } }),
  ].join("\n");
  const facts = buildFacts([parsePiFile(text, "/tmp/s.jsonl")]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].tool, "extract");
  assert.equal(facts[0].errorCode, "TAB_NOT_FOUND");
});

test("四态:ok / error / unpaired / unknown", () => {
  const claude = parseClaudeFile(
    [
      line({ timestamp: "2026-10-30T10:00:00Z", message: { content: [{ type: "tool_use", id: "c1", name: "mcp__vortex__vortex_act", input: {} }] } }),
      line({ timestamp: "2026-10-30T10:00:01Z", message: { content: [{ type: "tool_use", id: "c2", name: "mcp__vortex__vortex_act", input: {} }] } }),
      line({ timestamp: "2026-10-30T10:00:02Z", message: { content: [{ type: "tool_use", id: "c3", name: "mcp__vortex__vortex_act", input: {} }] } }),
      line({ timestamp: "2026-10-30T10:00:03Z", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "fine" }] }] } }),
      line({ timestamp: "2026-10-30T10:00:04Z", message: { content: [{ type: "tool_result", tool_use_id: "c2", is_error: true, content: [{ type: "text", text: "Error [TIMEOUT]: x" }] }] } }),
      // c3 无结果 → unpaired
    ].join("\n"),
    "/tmp/a.jsonl",
  );
  // sink:outcome=unknown → unknown(不能当成功)
  const sink = parseSinkFile(
    line({ ts: "2026-10-30T10:00:05.000Z", tool: "vortex_evaluate", outcome: "weird", errorCode: null, durationMs: 5, argLen: 1, resultLen: 2, client: null, pid: 1 }),
    "/tmp/sink/mcp-2026-10-30.jsonl",
  );

  const snap = reduceFacts(buildFacts([claude, sink]));
  assert.equal(snap.totals.calls, 3, "claude: 1 ok + 1 error + 1 unpaired");
  assert.equal(snap.totals.ok, 1);
  assert.equal(snap.totals.errors, 1);
  assert.equal(snap.totals.unpaired, 1);
  assert.equal(snap.totals.unknown, 1, "Pi 孤儿 result 归 unknown");
  assert.equal(snap.totals.settled, 2, "unknown/unpaired 不进分母");
  assert.equal(snap.totals.errorRate, 0.5);
});

test("unpaired: 有调用无结果,单独统计不进分母", () => {
  const claude = parseClaudeFile(
    line({ timestamp: "2026-10-30T10:00:00Z", message: { content: [{ type: "tool_use", id: "c9", name: "mcp__vortex__vortex_act", input: {} }] } }),
    "/tmp/a.jsonl",
  );
  const snap = reduceFacts(buildFacts([claude]));
  assert.equal(snap.totals.unpaired, 1);
  assert.equal(snap.totals.errors, 0);
  assert.equal(snap.totals.errorRate, null, "分母为 0 时错误率是 null,不是 0");
});

test("重复块只算一次", () => {
  const text = [
    line({ timestamp: "2026-10-30T10:00:00Z", message: { content: [{ type: "tool_use", id: "c1", name: "mcp__vortex__vortex_act", input: {} }] } }),
    line({ timestamp: "2026-10-30T10:00:00Z", message: { content: [{ type: "tool_use", id: "c1", name: "mcp__vortex__vortex_act", input: {} }] } }),
    line({ timestamp: "2026-10-30T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "r" }] }] } }),
  ].join("\n");
  const snap = reduceFacts(buildFacts([parseClaudeFile(text, "/tmp/a.jsonl")]));
  assert.equal(snap.totals.calls, 1);
});

test("空返回判定:isError 看不见的那一类", () => {
  assert.equal(isEmptySuccess([{ type: "text", text: "[]" }]), true);
  assert.equal(isEmptySuccess([{ type: "text", text: "{\"items\": []}" }]), true);
  assert.equal(isEmptySuccess([{ type: "text", text: "hello" }]), false);
  assert.equal(isEmptySuccess([{ type: "image", data: "..." }]), false, "非文本载荷不能判空");
});

test("codex: 只统计真正发起调用的 exec 脚本,源码/文档里的字样不算", () => {
  const text = [
    line({ payload: { type: "custom_tool_call", name: "exec", input: 'text(await tools.mcp__vortex__vortex_evaluate({code:"1"}));' } }),
    // 非 exec 的自定义工具：写文件时贴的示例不算一次调用
    line({ payload: { type: "custom_tool_call", name: "apply_patch", input: 'add tools.mcp__vortex__vortex_extract({tabId:1})' } }),
    // 会话里读的源码/文档片段:同样含调用字样,但不是 agent 真正发起的调用
    line({ payload: { type: "custom_tool_call_output", output: "文档片段 tools.mcp__vortex__vortex_extract({tabId:1}) 与 Error [TIMEOUT]" } }),
    line({ message: { content: [{ type: "tool_use", name: "mcp__vortex__vortex_evaluate" }] } }),
  ].join("\n");
  const scan = parseCodexFile(text);
  assert.equal(scan.calls.get("evaluate"), 1);
  assert.equal(scan.calls.has("extract"), false, "非 exec 工具与输出里的字样都不算调用");
});

test("errorCode: 取不到就归 <no-code>", () => {
  assert.equal(errorCode("Error [JS_EXECUTION_ERROR]: x"), "JS_EXECUTION_ERROR");
  assert.equal(errorCode("boom"), "<no-code>");
});

test("sink: vortex 自身遥测 JSONL 还原为事实行（服务端真相）", async () => {
  const { parseSinkFile } = await import("./extract.mjs");
  const text = [
    line({ ts: "2026-10-30T10:00:00.000Z", tool: "vortex_evaluate", outcome: "ok", errorCode: null, durationMs: 1200, argLen: 40, resultLen: 900, client: "claude-code@1.0.0", pid: 7 }),
    line({ ts: "2026-10-30T10:00:01.000Z", tool: "vortex_evaluate", outcome: "error", errorCode: "TIMEOUT", durationMs: 30000, argLen: 60, resultLen: 120, client: "claude-code@1.0.0", pid: 7 }),
  ].join("\n");
  const facts = buildFacts([parseSinkFile(text, "/tmp/sink/mcp-2026-10-30.jsonl")]);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].tool, "evaluate");
  assert.equal(facts[0].outcome, "ok");
  assert.equal(facts[0].resultLen, 900);
  const err = facts[1];
  assert.equal(err.outcome, "error");
  assert.equal(err.errorCode, "TIMEOUT");
  assert.equal(err.durationMs, 30000);
});

test("pi: codemode 里的 vortex 调用要被计入（只算没有 vortex 祖先的根调用）", async () => {
  const { parsePiFile } = await import("./extract.mjs");
  const text = [
    line({ type: "message", timestamp: "2026-10-30T10:00:00Z", message: { role: "assistant", content: [
      { type: "toolCall", id: "call_1", name: "codemode", arguments: { code: "await tools.mcp__vortex({tool:'vortex_extract'})" } },
    ] } }),
    line({ type: "message", timestamp: "2026-10-30T10:00:01Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "codemode", isError: false, durationMs: 900, content: [{ type: "text", text: "ok" }], nestedCalls: { calls: [
      { id: "call_1/1", name: "mcp__vortex", status: "ok", arguments: { tool: "vortex_extract", args: { tabId: 1 } }, durationMs: 700 },
      { id: "call_1/1/1", name: "mcp__vortex__vortex_extract", status: "ok", arguments: { tabId: 1 }, durationMs: 300 },
      { id: "call_1/2", name: "mcp__vortex", status: "error", arguments: { tool: "vortex_observe" }, durationMs: 120, error: "Error [TAB_NOT_FOUND]: No tab with id: 9" },
    ], complete: true } } }),
  ].join("\n");
  const facts = buildFacts([parsePiFile(text, "/tmp/s.jsonl")]);
  assert.equal(facts.length, 2, "根调用 2 个；/1/1 是 /1 的展开，不另计");
  const ok = facts.find((f) => f.tool === "extract");
  assert.equal(ok.outcome, "ok");
  assert.equal(ok.durationMs, 700);
  assert.equal(ok.emptySuccess, null, "嵌套记录没有返回正文 → 空返回不可判定");
  const err = facts.find((f) => f.tool === "observe");
  assert.equal(err.outcome, "error");
  assert.equal(err.errorCode, "TAB_NOT_FOUND");
});

test("sink: 未知结局不算成功；空返回不可判定", async () => {
  const { parseSinkFile } = await import("./extract.mjs");
  const text = [
    line({ ts: "2026-10-30T10:00:00.000Z", tool: "vortex_evaluate", outcome: "ok", errorCode: null, durationMs: 10, argLen: 1, resultLen: 900, client: null, pid: 1 }),
    line({ ts: "2026-10-30T10:00:01.000Z", tool: "vortex_evaluate", outcome: "mystery", errorCode: null, durationMs: 10, argLen: 1, resultLen: 900, client: null, pid: 1 }),
  ].join("\n");
  const snap = reduceFacts(buildFacts([parseSinkFile(text, "/tmp/sink/mcp-2026-10-30.jsonl")]));
  assert.equal(snap.totals.ok, 1);
  assert.equal(snap.totals.unknown, 1);
  assert.equal(snap.totals.emptySuccess, 0, "没有正文就不能判空返回");
  assert.equal(snap.totals.emptyUnknown, 1);
});
