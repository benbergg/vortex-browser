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

import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VtxError, VtxErrorCode } from "@vortex-browser/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_WAIT_TS = resolve(__dirname, "../src/action/auto-wait.ts");

const checkActionability = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...args: unknown[]) => checkActionability(...args),
}));
const { waitActionable } = await import("../src/action/auto-wait.js");

async function codeOf(reason: string, extras?: Record<string, unknown>) {
  checkActionability.mockResolvedValue({ ok: false, reason, ...(extras ? { extras } : {}) });
  try {
    await waitActionable(42, undefined, "#t", { timeout: 60 });
  } catch (e) {
    return (e as VtxError).code;
  }
  return null;
}

describe("auto-wait default timeout = 2000ms (was 5000ms)", () => {
  it("DEFAULT_TIMEOUT_MS is exactly 2000", async () => {
    const src = await readFile(AUTO_WAIT_TS, "utf8");
    expect(src).toMatch(/DEFAULT_TIMEOUT_MS\s*=\s*2000/);
  });

  // 原为两条源码正则,断言的是那个三元表达式长什么样 —— 换行都能让它红,
  // 而真把 NOT_STABLE 改回 TIMEOUT 只要保持写法就照样绿。改成跑真代码看抛什么码。
  it("超时后按 lastReason 决定错误码，而不是一律 TIMEOUT", async () => {
    // NOT_STABLE / OBSCURED 各自的 hint 才是可执行的;压成 TIMEOUT 就只剩
    // 「加大 timeout / 等 idle」——对这两种原因都是死路。
    expect(await codeOf("NOT_STABLE")).toBe(VtxErrorCode.NOT_STABLE);
    expect(await codeOf("OBSCURED", { blocker: "div.mask" })).toBe(VtxErrorCode.OBSCURED);
    // NOT_ATTACHED 仍是 TIMEOUT:它的恢复路径挂在 lastReason 上(descriptor 自愈 /
    // dispatch-error 的根因拼接),换码会打断,不属于本次改动范围。
    expect(await codeOf("NOT_ATTACHED")).toBe(VtxErrorCode.TIMEOUT);
    expect(await codeOf("NOT_VISIBLE")).toBe(VtxErrorCode.TIMEOUT);
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
