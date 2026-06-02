import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * O-8 observe 采 framework UI state 的源码级合约测试。
 *
 * 目的：代理拿到 observe 结果后能立刻看出每个 checkbox / radio / tab 的
 * 当前 checked / selected / active 状态，不必再用 js_evaluate 补查 class。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe UI state extraction (@since 0.4.0 O-8)", () => {
  it("page-side has a getUiState helper that looks up ancestor class + aria", () => {
    expect(OBSERVE_SRC).toMatch(/function\s+getUiState/);
    // 至少扫 2 层 ancestor
    expect(OBSERVE_SRC).toMatch(/i\s*<\s*3\s*&&\s*cur/);
  });

  it("derives checked from class 'is-checked' OR aria-checked", () => {
    expect(OBSERVE_SRC).toMatch(/is-checked/);
    expect(OBSERVE_SRC).toMatch(/aria-checked/);
  });

  it("derives selected from class 'is-selected' OR aria-selected", () => {
    expect(OBSERVE_SRC).toMatch(/is-selected/);
    expect(OBSERVE_SRC).toMatch(/aria-selected/);
  });

  it("derives active from class 'is-active' OR aria-pressed", () => {
    expect(OBSERVE_SRC).toMatch(/is-active/);
    expect(OBSERVE_SRC).toMatch(/aria-pressed/);
  });

  it("derives disabled from :disabled pseudo (covers fieldset cascade) OR aria-disabled", () => {
    // 用 :disabled 伪类而非 IDL .disabled,以覆盖 <fieldset disabled> 级联禁用
    // 的子控件(IDL .disabled 仍为 false,2026-06-02 dogfood)。
    expect(OBSERVE_SRC).toMatch(/\.matches\(":disabled"\)/);
    expect(OBSERVE_SRC).toMatch(/aria-disabled/);
  });

  it("state is only attached when non-empty (avoid noisy {} on plain elements)", () => {
    expect(OBSERVE_SRC).toMatch(/Object\.keys\(s\)\.length\s*>\s*0/);
    // spread-if pattern on element push
    expect(OBSERVE_SRC).toMatch(/\.\.\.\(state\s*\?\s*\{\s*state\s*\}\s*:\s*\{\s*\}\)/);
  });

  it("ScannedElement and elementsOut types include optional state field", () => {
    // 类型层把 state 暴露出来，不要让它只出现在页面内然后被 outer 丢掉
    expect(OBSERVE_SRC).toMatch(
      /state\?:\s*\{\s*checked\?:\s*boolean[\s\S]{0,120}?disabled\?:\s*boolean\s*\}/,
    );
  });
});
