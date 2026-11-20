// 路由份额（routes）单测：node --test scripts/usage-baseline/
//
// D-2(2026-11-20): browserRoute() 此前只在 claude 分支被调用，
// 于是 snapshot.routes.vortex 恒等于 Claude 源调用数、Pi 源恒 0 ——
// “vortex 占比”这条指标在 Pi 主力窗口里是错的。
//
// 这里锁两件事：
//   ① assembleRoutes：三源分账（Pi 不再恒 0；sink 不进路由份额）
//   ② countPlaywrightCalls：三源各自的调用形态都能扫到 playwright

import { test } from "node:test";
import assert from "node:assert/strict";
import { countPlaywrightCalls, assembleRoutes } from "./collect.mjs";

const FROM = Date.parse("2026-10-30T00:00:00Z");
const TO = Date.parse("2026-11-06T00:00:00Z");
const TS = "2026-10-31T10:00:00Z";
const line = (o) => JSON.stringify(o);

test("D-2: assembleRoutes 三源分账，Pi 不再恒 0", () => {
  const coverage = {
    perSource: {
      claude: { calls: 457 },
      pi: { calls: 115 },
      codex: { calls: 0 },
      sink: { calls: 572 },
    },
    codexAux: { calls: 7 },
  };
  const routes = assembleRoutes(coverage, { claude: 12, pi: 3, codex: 1 });
  assert.equal(routes.bySource.claude.vortex, 457);
  assert.equal(routes.bySource.pi.vortex, 115, "Pi 源此前恒 0");
  assert.equal(routes.bySource.codex.vortex, 7, "codex 是文本级辅助证据");
  assert.equal(routes.vortex, 579);
  assert.equal(routes.playwright, 16);
  assert.equal(routes.sinkServerSide, 572, "sink 是服务端镜像，不进路由份额");
  assert.ok(routes.vortexShare > 0);
});

test("D-2: playwright 路由扫描覆盖三源各自的调用形态", () => {
  const claudeRaw = [
    line({
      timestamp: TS,
      message: {
        content: [
          { type: "tool_use", id: "c1", name: "mcp__playwright__browser_click", input: {} },
          { type: "tool_use", id: "c2", name: "mcp__vortex__vortex_act", input: {} },
          { type: "tool_use", id: "c3", name: "Bash", input: { command: "npx playwright test" } },
        ],
      },
    }),
  ].join("\n");
  assert.equal(countPlaywrightCalls("claude", claudeRaw, FROM, TO), 2);

  const piRaw = [
    line({
      timestamp: TS,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "p1", name: "mcp__playwright", arguments: { tool: "browser_click" } },
        ],
      },
    }),
    line({
      timestamp: TS,
      message: {
        role: "toolResult",
        toolCallId: "p1",
        nestedCalls: {
          calls: [
            { id: "p1/1", name: "mcp__playwright__browser_click" },
            { id: "p1/1/1", name: "mcp__playwright__browser_click" },
          ],
        },
      },
    }),
  ].join("\n");
  // 外层代理 1 次 + 展开层 p1/1（同一逻辑调用）→ 去重后只算 1；p1/1/1 是 p1/1 的展开层 → 也跳过
  assert.equal(countPlaywrightCalls("pi", piRaw, FROM, TO), 1, "同一次 playwright 调用不能重复计");

  const piContainerRaw = [
    line({
      timestamp: TS,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "m1", name: "mcp__vortex", arguments: { tool: "vortex_query" } },
        ],
      },
    }),
    line({
      timestamp: TS,
      message: {
        role: "toolResult",
        toolCallId: "m1",
        nestedCalls: {
          calls: [{ id: "m1/1", name: "mcp__playwright__browser_click" }],
        },
      },
    }),
  ].join("\n");
  // 祖先是普通容器（不是 playwright）→ 里面的 playwright 调用是另一次调用，必须计入
  assert.equal(countPlaywrightCalls("pi", piContainerRaw, FROM, TO), 1, "普通容器下的 playwright 不能被漏算");

  const codexRaw = [
    line({
      timestamp: TS,
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: "await tools.mcp__playwright__browser_navigate({url:'x'});",
      },
    }),
  ].join("\n");
  assert.equal(countPlaywrightCalls("codex", codexRaw, FROM, TO), 1);
});

test("D-2: 窗口外的调用不计入路由份额", () => {
  const raw = [
    line({
      timestamp: "2026-11-20T10:00:00Z",
      message: { content: [{ type: "tool_use", id: "c1", name: "mcp__playwright__browser_click", input: {} }] },
    }),
  ].join("\n");
  assert.equal(countPlaywrightCalls("claude", raw, FROM, TO), 0);
});

test("D-2: Pi 的时间归属看外层调用，与抽取器 parsePiFile 一致", () => {
  // ① 外层在窗口前、结果在窗口内 → 外层调用不在窗口内 → 不计
  const outerBefore = [
    line({
      timestamp: "2026-10-29T10:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "p1", name: "mcp__playwright", arguments: { tool: "browser_click" } }],
      },
    }),
    line({
      timestamp: TS,
      message: {
        role: "toolResult",
        toolCallId: "p1",
        nestedCalls: { calls: [{ id: "p1/1", name: "mcp__playwright__browser_click" }] },
      },
    }),
  ].join("\n");
  assert.equal(countPlaywrightCalls("pi", outerBefore, FROM, TO), 0, "外层不在窗口内 → 结果在窗口内也不计");

  // ② codemode 外层在窗口内、结果在窗口后 → 算窗口内（抽取器也是这个口径）
  const resultAfter = [
    line({
      timestamp: TS,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "m2", name: "mcp__vortex", arguments: { tool: "vortex_query" } }],
      },
    }),
    line({
      timestamp: "2026-11-07T10:00:00Z",
      message: {
        role: "toolResult",
        toolCallId: "m2",
        nestedCalls: { calls: [{ id: "m2/1", name: "mcp__playwright__browser_click" }] },
      },
    }),
  ].join("\n");
  assert.equal(countPlaywrightCalls("pi", resultAfter, FROM, TO), 1, "外层在窗口内 → 结果在窗口外也计");

  // ③ 同一次 toolResult 重复出现 → 只计 1（按外层调用 id 去重）
  const dupResult = [
    line({
      timestamp: TS,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "m3", name: "mcp__vortex", arguments: { tool: "vortex_query" } }],
      },
    }),
    line({
      timestamp: TS,
      message: {
        role: "toolResult",
        toolCallId: "m3",
        nestedCalls: { calls: [{ id: "m3/1", name: "mcp__playwright__browser_click" }] },
      },
    }),
    line({
      timestamp: TS,
      message: {
        role: "toolResult",
        toolCallId: "m3",
        nestedCalls: { calls: [{ id: "m3/1", name: "mcp__playwright__browser_click" }] },
      },
    }),
  ].join("\n");
  assert.equal(countPlaywrightCalls("pi", dupResult, FROM, TO), 1, "重复的 toolResult 不能重复计");
});
