import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:连接失败的兜底文案不得引导调用 vortex_ping(2026-06-04 审计)。
 *
 * 背景:vortex_ping v0.6 从 PUBLIC_TOOLS 移出后**完全不可达**(getToolDef 只查
 * publicMap,tools/call 直接 Unknown tool),旧 ECONNREFUSED 文案写 "Run the
 * 'vortex_ping' tool to re-check connectivity" → agent 照做 → 死胡同。
 * (ping 内部化仍保留供 diagnostic fingerprint,故不删 handler,仅修文案。)
 *
 * 2026-11-20 D-1 更新:ping 已通过 registry.resolveToolDef() 接回 tools/call
 * (不进 tools/list,公开面不变胖)。但本条约束**依然成立** —— 连接失败不是 ping
 * 能解决的问题,引导 agent 去 ping 只是浪费一轮。故断言不变,只更新过时注释。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(
  join(__dirname, "..", "src", "server.ts"),
  "utf8",
);

describe("连接失败文案不引导调用 vortex_ping (2026-06-04 审计)", () => {
  it("不再让 agent 调 vortex_ping(连接失败靠重试解决,不是靠 ping)", () => {
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
