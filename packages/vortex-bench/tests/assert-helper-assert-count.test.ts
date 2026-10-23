// assertResultContains 的成功路径也必须过一次 ctx.assert ——
// runner 侧的断言计数（防假绿闸门）只认 ctx.assert，helper 命中期望文本后直接
// return 的话，用例会被误判成「零断言 → assertion_failure」（22 个既有 case 命中此路径）。

import { describe, it, expect, vi } from "vitest";
import type { CaseContext } from "../src/types.js";
import { assertResultContains } from "../cases/_helpers.js";

function fakeCtx(text: string): { ctx: CaseContext; assertMock: ReturnType<typeof vi.fn> } {
  const assertMock = vi.fn();
  const ctx = {
    call: vi.fn(async () => ({ content: [{ text }] })),
    assert: assertMock,
  } as unknown as CaseContext;
  return { ctx, assertMock };
}

describe("assertResultContains 的断言计数", () => {
  it("结果已含期望文本 → 记一次 ctx.assert(true)，不抛错", async () => {
    const { ctx, assertMock } = fakeCtx("value=42");

    await assertResultContains(ctx, "value=42");

    expect(assertMock).toHaveBeenCalledTimes(1);
    expect(assertMock.mock.calls[0][0]).toBe(true);
  });

  it("结果始终不含期望文本 → 走失败分支，记一次 ctx.assert(false, ...)", async () => {
    const { ctx, assertMock } = fakeCtx("value=0");

    // 失败分支会重试 6×500ms，给足超时
    await assertResultContains(ctx, "value=42");

    expect(assertMock).toHaveBeenCalledTimes(1);
    expect(assertMock.mock.calls[0][0]).toBe(false);
  }, 10_000);
});
