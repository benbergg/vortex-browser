import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:连接失败的兜底文案不得引导调用不可达的 vortex_ping(2026-06-04 审计)。
 *
 * vortex_ping v0.6 已从 PUBLIC_TOOLS 移出(getToolDef 仅查 publicMap),agent 经
 * tools/call 调它直接 "Unknown tool"。旧 ECONNREFUSED 文案写 "Run the 'vortex_ping'
 * tool to re-check connectivity" → agent 照做 → 死胡同。改为引导重试上次调用。
 * (ping 内部化仍保留供 diagnostic fingerprint,故不删 handler,仅修文案。)
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(
  join(__dirname, "..", "src", "server.ts"),
  "utf8",
);

describe("连接失败文案不引导调用不可达的 vortex_ping (2026-06-04 审计)", () => {
  it("不再让 agent 调 vortex_ping(它不在 PUBLIC_TOOLS,tools/call 会 Unknown tool)", () => {
    expect(SERVER_SRC).not.toMatch(/Run the 'vortex_ping' tool/);
    expect(SERVER_SRC).not.toMatch(/vortex_ping' tool to re-check/);
  });

  it("ECONNREFUSED 文案改为引导重试上次调用(可执行指引)", () => {
    // friendly 文案块内须含「retry」类可执行指引,替代不可达的 ping。
    const block = SERVER_SRC.match(
      /vortex-server is not running[\s\S]{0,400}Original error/,
    );
    expect(block).not.toBeNull();
    expect(block?.[0]).toMatch(/retry/i);
  });
});
