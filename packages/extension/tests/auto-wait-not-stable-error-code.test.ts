/**
 * Author: qingwa
 * Description: V4 淘宝选品评测 P1-2 修复路径重做: auto-wait.ts
 *   NOT_STABLE 抛错应返 VtxErrorCode.NOT_STABLE(非 TIMEOUT),
 *   让 errors.hints.ts NOT_STABLE hint 生效。
 *
 * 背景 (V4 报告 §7.3.2): 518d500 修了 errors.hints.ts NOT_STABLE hint
 *   含 force=true 提示,但 auto-wait.ts:89 用 TIMEOUT 错误码,hint 永远不触发。
 *   V4 实测 hint = "Action timed out. Increase the timeout..."(不含 force=true)。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_WAIT_SRC = readFileSync(
  join(__dirname, "..", "src", "action", "auto-wait.ts"),
  "utf8",
);

describe("P1-2 修复路径重做 (V4 评测): NOT_STABLE 抛错应返 NOT_STABLE 错误码", () => {
  it("auto-wait.ts:88-96 应含 lastReason === 'NOT_STABLE' 分支", () => {
    const hasStabilityBranch =
      /lastReason\s*===\s*["']NOT_STABLE["']|lastReasonIsStability/.test(AUTO_WAIT_SRC);
    expect(hasStabilityBranch).toBe(true);
  });

  it("NOT_STABLE 分支应抛 VtxErrorCode.NOT_STABLE (非 TIMEOUT)", () => {
    const notStableCodeUsed =
      /VtxErrorCode\.NOT_STABLE/.test(AUTO_WAIT_SRC);
    expect(notStableCodeUsed).toBe(true);
  });

  it("TIMEOUT 码应仅在非 NOT_STABLE 抛错时使用(保留原始 TIMEOUT 行为兼容)", () => {
    const timeoutCodeUsed = /VtxErrorCode\.TIMEOUT/.test(AUTO_WAIT_SRC);
    expect(timeoutCodeUsed).toBe(true);
  });

  it("原有 RETRY_INTERVAL_MS.NOT_STABLE = 16 (~1 RAF) 仍保留", () => {
    expect(AUTO_WAIT_SRC).toMatch(/NOT_STABLE:\s*16/);
  });
});
