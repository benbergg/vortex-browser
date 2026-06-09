/**
 * Author: qingwa
 * Description: Verify auto-wait default timeout is 2000ms (was 5000ms).
 *
 * 背景 (Vortex JD Home Search Perf 优化 Task 1):
 *   - 现状: DEFAULT_TIMEOUT_MS = 5000ms, vortex_act/fill 每次 ~26s, 2 个 act 总 ~52s。
 *   - 目标: 2000ms, 每次 ~8s, 节省 ~36s。
 *   - Case 1: DEFAULT_TIMEOUT_MS 字面值 = 2000。
 *   - Case 2: NOT_STABLE → NOT_STABLE 错误码映射保持 (回归保护)。
 *   - Case 3: RETRY_INTERVAL_MS 表各 reason 间隔保持 (NOT_STABLE=16ms
 *     在 2s 内可重试 ~125 次,NOT_VISIBLE=50ms 约 40 次,OBSCURED=100ms
 *     约 20 次,NOT_ATTACHED=0ms 立即重试)。
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_WAIT_TS = resolve(__dirname, "../src/action/auto-wait.ts");

describe("auto-wait default timeout = 2000ms (was 5000ms)", () => {
  it("DEFAULT_TIMEOUT_MS is exactly 2000", async () => {
    const src = await readFile(AUTO_WAIT_TS, "utf8");
    expect(src).toMatch(/DEFAULT_TIMEOUT_MS\s*=\s*2000/);
  });

  it("NOT_STABLE within 2s still throws NOT_STABLE (not TIMEOUT)", async () => {
    const src = await readFile(AUTO_WAIT_TS, "utf8");
    expect(src).toMatch(
      /lastReasonIsStability\s*=\s*lastReason\s*===\s*"NOT_STABLE"/,
    );
    expect(src).toMatch(
      /lastReasonIsStability\s*\?\s*VtxErrorCode\.NOT_STABLE\s*:\s*VtxErrorCode\.TIMEOUT/,
    );
  });

  it("RETRY_INTERVAL_MS table still has fast intervals (NOT_STABLE=16ms = ~125 retries in 2s)", async () => {
    const src = await readFile(AUTO_WAIT_TS, "utf8");
    const table = src.match(
      /RETRY_INTERVAL_MS:\s*Record<[^>]+>\s*=\s*{[\s\S]*?};/,
    );
    expect(table).toBeTruthy();
    expect(table![0]).toMatch(/NOT_STABLE:\s*16/);
    expect(table![0]).toMatch(/NOT_VISIBLE:\s*50/);
    expect(table![0]).toMatch(/OBSCURED:\s*100/);
    expect(table![0]).toMatch(/NOT_ATTACHED:\s*0/);
  });
});
