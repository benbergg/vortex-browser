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
      /state\?:\s*\{\s*checked\?:\s*boolean[\s\S]{0,280}?invalid\?:\s*boolean\s*\}/,
    );
  });

  it("derives expanded from aria-expanded=true (T2,2026-06-02 dogfood)", () => {
    // 折叠/展开态菜单按钮原本 observe 输出完全相同。只在 ="true" 时打标记,
    // 且只查元素自身(不上溯祖先,避免无关父级展开态错配到子按钮)。
    expect(OBSERVE_SRC).toMatch(
      /getAttribute\("aria-expanded"\)\s*===\s*"true"/,
    );
    expect(OBSERVE_SRC).toMatch(/s\.expanded = true/);
  });

  it("derives required from native required OR aria-required (Y,2026-06-02 dogfood)", () => {
    // observe-render 早支持 [required] 标记但 producer 从未接线(死标记),
    // agent 填表不知哪些必填。原生 required + aria-required="true" 双覆盖。
    expect(OBSERVE_SRC).toMatch(/\.required === true/);
    expect(OBSERVE_SRC).toMatch(/getAttribute\("aria-required"\)\s*===\s*"true"/);
    expect(OBSERVE_SRC).toMatch(/s\.required = true/);
  });

  it("derives current from aria-current 按值判定(W,2026-06-02 dogfood)", () => {
    // 任何非 "false" 的 aria-current(page/step/true...)都置 current;
    // 按值判定而非属性存在(aria-current="false" 不应误标)。
    expect(OBSERVE_SRC).toMatch(/getAttribute\("aria-current"\)/);
    expect(OBSERVE_SRC).toMatch(/!==\s*"false"/);
    expect(OBSERVE_SRC).toMatch(/s\.current = true/);
  });

  it("derives invalid from aria-invalid 按值判定(Z,2026-06-02 dogfood)", () => {
    // true/grammar/spelling 均为无效,false/缺省有效。用 aria-invalid 显式信号,
    // 不用 :invalid 伪类(后者对初始空 required 字段噪声大)。
    expect(OBSERVE_SRC).toMatch(/getAttribute\("aria-invalid"\)/);
    expect(OBSERVE_SRC).toMatch(/s\.invalid = true/);
    // 不用 :invalid 伪类。
    expect(OBSERVE_SRC).not.toMatch(/matches\(":invalid"\)/);
  });

  it("getValueInfo 严格限定值域 role/控件,不对普通文本输入暴露 value(X)", () => {
    // VALUE_ROLES 仅含值域角色,绝不含 textbox(否则 password/email 值会泄漏进 observe)。
    const setMatch = OBSERVE_SRC.match(/const VALUE_ROLES = new Set\(\[([\s\S]*?)\]\)/);
    expect(setMatch).not.toBeNull();
    expect(setMatch?.[1]).toMatch(/"slider"/);
    expect(setMatch?.[1]).toMatch(/"spinbutton"/);
    expect(setMatch?.[1]).toMatch(/"progressbar"/);
    expect(setMatch?.[1]).not.toMatch(/"textbox"/);
    // 优先 aria-valuetext,否则 valuenow(+valuemax 拼 now/max)。
    expect(OBSERVE_SRC).toMatch(/getAttribute\("aria-valuetext"\)/);
    expect(OBSERVE_SRC).toMatch(/getAttribute\("aria-valuenow"\)/);
  });

  it("getRole 把原生 range→slider、number→spinbutton(X 配套)", () => {
    expect(OBSERVE_SRC).toMatch(/t === "range"\)\s*return "slider";/);
    expect(OBSERVE_SRC).toMatch(/t === "number"\)\s*return "spinbutton";/);
  });

  it("indeterminate <progress>(position===-1)不报值,避免 value=0 误导(评审修复)", () => {
    // IDL .value 对 indeterminate progress 返 0,会让 agent 误判「卡在 0%」。
    expect(OBSERVE_SRC).toMatch(/tag === "progress"\s*&&\s*\(el as HTMLProgressElement\)\.position === -1/);
  });

  it("aria-valuetext 归一化空白后再截断(评审修复:防破坏单行)", () => {
    expect(OBSERVE_SRC).toMatch(/valueText\.replace\(\/\\s\+\/g, " "\)/);
  });
});
