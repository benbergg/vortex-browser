/**
 * Author: qingwa
 * Description: Verify fillWithFallback drops legacy execCommand (3-step → 2-step).
 *
 * 背景 (Vortex JD Home Search Perf 优化 Task 3):
 *   - 现状: fillWithFallback 有 3 步 (execCommand → value-setter → insertText),
 *     execCommand 已被现代 React/Vue/Shadow DOM 弃用,每次走完 3 步额外消耗
 *     一个 5s waitActionable cycle。
 *   - 目标: 去掉 execCommand, 保留 value-setter (首步) + insertText (次步),
 *     每条 fill 节省 1 个 waitActionable cycle (~5s)。
 *   - Case 1: 源码中 tryFillExecCommand 完全删除 (无死代码)。
 *   - Case 2: value-setter 作为首步被尝试 (attempted.push("value-setter") + tryFillValueSetter 调用)。
 *   - Case 3: insertText (CDP Input.insertText) 作为次步被尝试。
 *   - Case 4: attempted.push 总共只调用 2 次 (无第 3 步)。
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FALLBACK_TS = resolve(__dirname, "../src/action/fallback.ts");

describe("fillWithFallback uses 2 steps (no execCommand)", () => {
  it("does not call tryFillExecCommand", async () => {
    const src = await readFile(FALLBACK_TS, "utf8");
    expect(src).not.toMatch(/tryFillExecCommand/);
  });

  it("uses value-setter as first attempt", async () => {
    const src = await readFile(FALLBACK_TS, "utf8");
    expect(src).toMatch(/attempted\.push\("value-setter"\)/);
    expect(src).toMatch(/tryFillValueSetter\(ctx, value\)/);
  });

  it("uses insertText (CDP) as second attempt", async () => {
    const src = await readFile(FALLBACK_TS, "utf8");
    expect(src).toMatch(/attempted\.push\("insertText"\)/);
    expect(src).toMatch(/Input\.insertText/);
  });

  it("exposes only 2 attempted.push calls inside fillWithFallback (no 3rd attempt)", async () => {
    const src = await readFile(FALLBACK_TS, "utf8");
    // Scope to fillWithFallback body so clickWithFallback's pushes don't count.
    const body = src.match(
      /export async function fillWithFallback\([\s\S]*?\n\}\n/,
    )?.[0] ?? "";
    const pushes = (body.match(/attempted\.push\(/g) ?? []).length;
    expect(pushes).toBe(2);
  });
});
