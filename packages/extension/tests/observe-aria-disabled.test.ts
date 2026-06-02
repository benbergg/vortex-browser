import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// observe 的 disabled 判定跑在 page-side scan func 内,不可 import 单测,
// 故 source-grep 守护「aria-disabled 按值判定」不回退成「按属性存在判定」
// (2026-06-01 dialog dogfood:Element Plus 给启用元素写 aria-disabled="false")。
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "../src/handlers/observe.ts"),
  "utf8",
);

describe("observe aria-disabled 按值判定", () => {
  it("仅 aria-disabled 值为 \"true\" 才视为禁用", () => {
    expect(OBSERVE_SRC).toMatch(
      /getAttribute\("aria-disabled"\)\s*===\s*"true"/,
    );
  });

  it("不再用 hasAttribute(\"aria-disabled\") 判禁用(会把 =\"false\" 误标)", () => {
    expect(OBSERVE_SRC).not.toMatch(/hasAttribute\("aria-disabled"\)/);
  });

  it("原生禁用用 :disabled 伪类判定(覆盖 fieldset 级联,2026-06-02 dogfood)", () => {
    // <fieldset disabled> 级联禁用的子控件 IDL .disabled 仍为 false,只有
    // :disabled 伪类反映真状态。故必须用 matches(":disabled") 而非 .disabled。
    expect(OBSERVE_SRC).toMatch(/\.matches\(":disabled"\)/);
  });

  it("不再用 IDL .disabled 判原生禁用(会漏 fieldset 级联禁用控件)", () => {
    // 严格超集:matches(":disabled") 同时覆盖直接 disabled + fieldset 级联,
    // 不应残留旧的 IDL 判定回退。
    expect(OBSERVE_SRC).not.toMatch(/\(el as HTMLInputElement\)\.disabled === true/);
  });
});
