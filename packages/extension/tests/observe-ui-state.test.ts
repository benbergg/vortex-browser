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

  it("aria-checked/selected/pressed 仅读元素自身(i===0),不上溯祖先误归子控件", () => {
    // LIVE 确认(2026-06-04 审计):<div role=option aria-selected=true><button>
    // 的子 button 误带 [selected]。is-* 组件类约定可落包裹祖先(Element Plus),
    // 但 ARIA 这些布尔态按规范在角色元素自身,上溯祖先会把容器状态错配给内部子
    // 控件。aria-* 读取须受 self(i===0)门控。
    expect(OBSERVE_SRC).toMatch(/const selfAria = i === 0/);
    expect(OBSERVE_SRC).toMatch(/selfAria && cur\.getAttribute\("aria-checked"\)/);
    expect(OBSERVE_SRC).toMatch(/selfAria && cur\.getAttribute\("aria-selected"\)/);
    expect(OBSERVE_SRC).toMatch(/selfAria && cur\.getAttribute\("aria-pressed"\)/);
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
      /state\?:\s*\{\s*checked\?:\s*boolean[\s\S]{0,360}?invalid\?:\s*boolean[\s\S]{0,90}?\}/,
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

  it("required 对包裹式 <label><input required> 钻入内嵌控件读(2026-06-04 审计)", () => {
    // surface 元素是 label 时,required 在内嵌 input/select/textarea 上,label 自身
    // .required 为 undefined → 漏标。同 checked 钻入内嵌控件(LABEL → querySelector
    // input/select/textarea),否则 <label><input required> 永不显示 [required]。
    expect(OBSERVE_SRC).toMatch(/let reqProbe[\s\S]{0,120}el\.tagName === "LABEL"/);
    expect(OBSERVE_SRC).toMatch(/querySelector\(\s*"input, select, textarea"\s*\)/);
    expect(OBSERVE_SRC).toMatch(/\(reqProbe as HTMLInputElement\)\.required === true/);
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

  it("derives sort from aria-sort 排序列方向(AC,2026-06-02 dogfood)", () => {
    // ascending/descending 原样存方向,none → 标 sortable(可排未排,区别普通表头);
    // 只查元素自身(aria-sort 按 ARIA 惯例落在 columnheader 自身)。
    expect(OBSERVE_SRC).toMatch(/getAttribute\("aria-sort"\)/);
    expect(OBSERVE_SRC).toMatch(
      /ariaSort === "ascending" \|\| ariaSort === "descending"/,
    );
    expect(OBSERVE_SRC).toMatch(/s\.sort = ariaSort/);
    // none 与 other(罕见,非升降序)都 → sortable
    expect(OBSERVE_SRC).toMatch(/ariaSort === "none" \|\| ariaSort === "other"/);
    expect(OBSERVE_SRC).toMatch(/s\.sort = "none"/);
  });

  it("把 aria-activedescendant 指向的虚拟焦点项标 active(AE,2026-06-02 dogfood)", () => {
    // combobox/listbox/tree/grid 方向键导航时,高亮项焦点不在该项 DOM 上,只由
    // 触发器的 aria-activedescendant 指过来。把每个触发器的 IDREF 在其自身 root 内
    // 解析成真元素收进 Set,目标复用既有 [active] flag(虚拟焦点 ≡「一组里当前激活
    // 那个」),不新增 flag 语法。集合用 querySelectorAllDeep 穿 open shadow 收触发器。
    expect(OBSERVE_SRC).toMatch(/const activeDescendantEls = new Set<Element>\(\)/);
    expect(OBSERVE_SRC).toMatch(
      /querySelectorAllDeep\("\[aria-activedescendant\]", document\)/,
    );
    // 必须在 host.getRootNode() 内解析 IDREF(scope 正确 + 滤悬空),不能全局按 id
    // 字符串匹配(跨 shadow/文档同名 id 会误标无关元素,评审 LOW)。
    expect(OBSERVE_SRC).toMatch(/host\.getRootNode\(\)/);
    expect(OBSERVE_SRC).toMatch(/getElementById\(id\)/);
    // getUiState 据元素身份命中集合 → s.active(复用,不新增 flag)。
    expect(OBSERVE_SRC).toMatch(/activeDescendantEls\.has\(el\)/);
  });

  it("把 aria-haspopup 弹层可供性暴露为 haspopup(AA,2026-06-02 dogfood)", () => {
    // 菜单按钮/拆分按钮/combobox 点击会弹出 menu/listbox/tree/grid/dialog,
    // agent 据此预判弹层、规划多步交互。"true"→"menu" 规范化;非法值兜底 menu;
    // "false"/缺省不发(值语义判定)。
    expect(OBSERVE_SRC).toMatch(/getAttribute\("aria-haspopup"\)/);
    expect(OBSERVE_SRC).toMatch(/ariaHaspopup != null && ariaHaspopup !== "false"/);
    expect(OBSERVE_SRC).toMatch(/s\.haspopup =/);
    // 白名单透传 listbox/tree/grid/dialog,其余(含 "true")规范化为 "menu"。
    expect(OBSERVE_SRC).toMatch(/ariaHaspopup === "listbox"/);
    expect(OBSERVE_SRC).toMatch(/:\s*"menu"/);
  });
});
