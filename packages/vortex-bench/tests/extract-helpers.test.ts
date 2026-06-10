// packages/vortex-bench/tests/extract-helpers.test.ts
// 缺口 J P2 — extract case helpers（包 vortex_extract + 容差纯函数）。
import { describe, it, expect } from "vitest";
import {
  assertExtractEquals,
  assertExtractContainsAll,
  assertExtractNumericBand,
  assertExtractNotContains,
  findRef,
} from "../cases/_helpers.js";
import type { CaseContext } from "../src/types.js";

/**
 * 构造最小 mock ctx：call 返回固定文本，assert 失败即 throw（仿 runCase AssertionError）。
 * 关键：vortex_extract 真实返回 **JSON 编码** 的值（单元素 → `"Coframe"` 带引号），
 * 故 mock 用 JSON.stringify 还原真实形态——helper 须先 unwrap 才能正确 exactMatch。
 * （2026-06-04 live 验收坐实：mock 用裸文本会漏掉这个 bug。）
 */
function mockCtx(text: string): { ctx: CaseContext; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const ctx = {
    playgroundUrl: "http://x",
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(text) }] };
    },
    async fallbackEvaluate() {
      return {};
    },
    recordObserveMiss() {},
    assert(cond: unknown, message: string) {
      if (!cond) throw new Error(message);
    },
    recordMetric() {},
  } as unknown as CaseContext;
  return { ctx, calls };
}

describe("assertExtractEquals", () => {
  it("提取文本规范化后相等 → 通过", async () => {
    const { ctx } = mockCtx("  Coframe ");
    await expect(assertExtractEquals(ctx, "#cell", "coframe")).resolves.toBeUndefined();
  });
  it("不等 → 抛断言错(含期望与实际)", async () => {
    const { ctx } = mockCtx("OpusClip");
    await expect(assertExtractEquals(ctx, "#cell", "Coframe")).rejects.toThrow(/Coframe/);
  });
  it("fuzzy 阈值容忍格式噪声 → 通过", async () => {
    const { ctx } = mockCtx("Scalable Architecture");
    await expect(
      assertExtractEquals(ctx, "#cell", "scalable architecture", { fuzzy: 0.9 }),
    ).resolves.toBeUndefined();
  });
  it("以 {target, include:['text']} 调 vortex_extract", async () => {
    const { ctx, calls } = mockCtx("Coframe");
    await assertExtractEquals(ctx, "#cell", "Coframe");
    const extractCall = calls.find((c) => c.name === "vortex_extract");
    expect(extractCall).toBeDefined();
    expect(extractCall!.args).toMatchObject({ target: "#cell", include: ["text"] });
  });
});

describe("assertExtractContainsAll", () => {
  it("全部关键值都在 → 通过", async () => {
    const { ctx } = mockCtx("Row A 201\nRow B 202\nRow C 203");
    await expect(
      assertExtractContainsAll(ctx, "#table", ["201", "202", "203"]),
    ).resolves.toBeUndefined();
  });
  it("缺失 → 抛错且 message 含 missing 值", async () => {
    const { ctx } = mockCtx("Row A 201");
    await expect(
      assertExtractContainsAll(ctx, "#table", ["201", "999"]),
    ).rejects.toThrow(/999/);
  });
});

describe("assertExtractNumericBand", () => {
  it("数值落容差带 → 通过（k 后缀）", async () => {
    const { ctx } = mockCtx("236k stars");
    await expect(
      assertExtractNumericBand(ctx, "#stars", 236000, 1000),
    ).resolves.toBeUndefined();
  });
  it("超出容差带 → 抛错", async () => {
    const { ctx } = mockCtx("236k");
    await expect(
      assertExtractNumericBand(ctx, "#stars", 240000, 1000),
    ).rejects.toThrow();
  });
});

describe("findRef（按 accessible name 从 observe 快照取 ref）", () => {
  // a11y-tree 格式：`- role "name" [ref=@..]`（旧扁平是行首 @ref [role] "name"）。
  const snap = [
    "SnapshotId: snap_x",
    '- button "open shadow 按钮" [ref=@e985:e0]',
    '- button "iframe 同源按钮" [ref=@7336:f354e1]',
    '- link "纯 ref 无 hash" [ref=@e0]',
  ].join("\n");
  it("hashed ref 命中", () => {
    expect(findRef(snap, "open shadow 按钮")).toBe("@e985:e0");
  });
  it("跨帧 hashed ref(含 fN 段)命中", () => {
    expect(findRef(snap, "iframe 同源按钮")).toBe("@7336:f354e1");
  });
  it("无 hash 的纯 ref 命中", () => {
    expect(findRef(snap, "纯 ref 无 hash")).toBe("@e0");
  });
  it("名字不存在 → null", () => {
    expect(findRef(snap, "不存在的按钮")).toBeNull();
  });
});

describe("assertExtractNotContains", () => {
  it("禁出现值不在 → 通过", async () => {
    const { ctx } = mockCtx("Coframe");
    await expect(
      assertExtractNotContains(ctx, "#cell", "OpusClip"),
    ).resolves.toBeUndefined();
  });
  it("禁出现值出现了 → 抛错", async () => {
    const { ctx } = mockCtx("Coframe and OpusClip");
    await expect(
      assertExtractNotContains(ctx, "#cell", "OpusClip"),
    ).rejects.toThrow();
  });
});
