import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMIT_DRIVERS, findDriver } from "../src/patterns/commit-drivers.js";

/**
 * 回归锁:act 原语白盒审计批次 4b —— 族 I #24 通用 ARIA combobox/listbox driver。
 * react-select / antd Select / MUI / Radix / Headless UI 都遵循 W3C ARIA APG:
 *  trigger 开 [role="listbox"] 弹层、选项 [role="option"]、选中 aria-selected="true"。
 * 现 commit 仅 6 个 Element Plus el-* 驱动,对现代 React 组件库零覆盖。新增 `aria-select`
 * kind 的通用驱动:开弹层 → 定位 listbox(aria-controls/portal)→ 找 option(等异步/
 * typeahead 过滤/跳 aria-disabled)→ verify(valueText 排除菜单子树 或 aria-selected)。
 * page-side IIFE 不可 import,source-grep 守护;真站 live 验证(antd/react-select,报告 §28)。
 * 2026-06-03 act 原语白盒审计。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ARIA_SRC = readFileSync(
  join(__dirname, "../src/page-side/commit-drivers/aria-select.ts"),
  "utf8",
);
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");

describe("#24 registry — aria-select driver 已注册", () => {
  it("findDriver('aria-select') 返回 generic-aria-select", () => {
    const d = findDriver("aria-select");
    expect(d).toBeDefined();
    expect(d?.id).toBe("generic-aria-select");
  });
  it("closestSelector 覆盖 combobox/listbox ARIA role", () => {
    const d = findDriver("aria-select");
    expect(d?.closestSelector).toMatch(/role="combobox"/);
    expect(d?.closestSelector).toMatch(/role="listbox"/);
  });
  it("driver 有完整 id/kind/closestSelector/summary", () => {
    const d = COMMIT_DRIVERS.find((x) => x.id === "generic-aria-select");
    expect(d?.kind).toBe("aria-select");
    expect((d?.summary.length ?? 0)).toBeGreaterThan(10);
  });
});

describe("#24 page-side driver — 开弹层 + 定位 listbox", () => {
  it("attaches to window.__vortexCommitAriaSelect", () => {
    expect(ARIA_SRC).toMatch(/window as any\)\.__vortexCommitAriaSelect/);
  });
  it("点 trigger 开弹层(dispatchMouseClick)", () => {
    expect(ARIA_SRC).toMatch(/dispatchMouseClick\(trigger\)/);
  });
  it("经 aria-controls/aria-owns 定位 listbox,兜底文档级扫 role=listbox", () => {
    expect(ARIA_SRC).toMatch(/aria-controls/);
    expect(ARIA_SRC).toMatch(/aria-owns/);
    expect(ARIA_SRC).toMatch(/\[role="listbox"\]/);
  });
});

describe("#24 page-side driver — 找选项(等异步 / typeahead / 跳 disabled / norm)", () => {
  it("用 waitFor 轮询等异步选项 + 共享 deadline remaining", () => {
    expect(ARIA_SRC).toMatch(/await waitFor\(/);
    expect(ARIA_SRC).toMatch(/const remaining = \(\) =>/);
  });
  it("选项匹配过 norm 折叠空白", () => {
    expect(ARIA_SRC).toMatch(/norm\(.*textContent/);
  });
  it("跳过 aria-disabled 选项", () => {
    expect(ARIA_SRC).toMatch(/aria-disabled.*!==\s*"true"|getAttribute\("aria-disabled"\)/);
  });
  it("typeahead 兜底:找不到且有 input 时写值过滤", () => {
    expect(ARIA_SRC).toMatch(/querySelector\('input/);
    expect(ARIA_SRC).toMatch(/nativeInputValueSetter|HTMLInputElement\.prototype/);
  });
  it("命中文本但禁用报明确 disabled 错误", () => {
    expect(ARIA_SRC).toMatch(/is disabled and cannot be selected/);
  });
});

describe("#24 page-side driver — verify 回读防 silent-false-success", () => {
  it("valueText 排除 listbox 子树避开 inline 菜单假阳", () => {
    expect(ARIA_SRC).toMatch(/valueText/);
    expect(ARIA_SRC).toMatch(/role.*listbox|"listbox"/);
  });
  it("verify 接受 aria-selected 信号", () => {
    expect(ARIA_SRC).toMatch(/aria-selected="true"|aria-selected.*true/);
  });
  it("未反映报 COMMIT_FAILED stage verify", () => {
    expect(ARIA_SRC).toMatch(/COMMIT_FAILED/);
    expect(ARIA_SRC).toMatch(/stage:\s*"verify"/);
  });
});

describe("#24 COMMIT handler 接线", () => {
  it("dom.ts 为 aria-select 加载 commit-aria-select 模块 + dispatch driverId", () => {
    expect(DOM_SRC).toMatch(/commit-aria-select/);
    expect(DOM_SRC).toMatch(/__vortexCommitAriaSelect/);
  });
});

describe("#24 live 修 — antd v6 非合规 + react-select root", () => {
  it("root 不潜入 target 内部找 combobox(react-select 0×0 input)", () => {
    expect(ARIA_SRC).toMatch(/const root = \(target\.closest\(closestSelector\) \?\? target\)/);
    expect(ARIA_SRC).not.toMatch(/target\.querySelector\(closestSelector\)/);
  });
  it("trigger 候选含 root 可见祖先(react-select control 无 ARIA role)", () => {
    expect(ARIA_SRC).toMatch(/anc = root\.parentElement/);
  });
  it("option 识别有 antd 类名兜底(role=option 在 0 宽节点时)", () => {
    expect(ARIA_SRC).toMatch(/ant-select-item-option/);
    expect(ARIA_SRC).toMatch(/OPTION_FALLBACK_SEL/);
  });
  it("disabled/selected 兼容 aria 属性 + antd class", () => {
    expect(ARIA_SRC).toMatch(/ant-select-item-option-disabled/);
    expect(ARIA_SRC).toMatch(/ant-select-item-option-selected/);
  });
  it("optionPool 经 aria-controls 祖先作用域锁本 select(防多 select 污染)", () => {
    expect(ARIA_SRC).toMatch(/ariaControlsScope/);
  });
  it("开弹层有键盘兜底:focus input + 合成 ArrowDown(react-select gating 鼠标 isTrusted)", () => {
    expect(ARIA_SRC).toMatch(/kbTarget\?\.focus/);
    expect(ARIA_SRC).toMatch(/new KeyboardEvent\("keydown"[\s\S]{0,80}ArrowDown/);
  });
});

describe("#24 聚焦评审修复 — 作用域锚定 + 键盘开安全", () => {
  it("HIGH-1 aria-controls id 来源扫 root 子树(antd 在内层 input 上)", () => {
    expect(ARIA_SRC).toMatch(/const controlsId = \(\)/);
    expect(ARIA_SRC).toMatch(/root\.querySelector\("\[aria-controls\]"\)/);
  });
  it("MEDIUM-2 ariaControlsScope 上溯到 body 即停", () => {
    expect(ARIA_SRC).toMatch(/el !== document\.body/);
  });
  it("HIGH-2 键盘开 kbTarget 限定搜索式 input + 清残留过滤串", () => {
    expect(ARIA_SRC).toMatch(/input\[role="combobox"\], input\[aria-autocomplete\]/);
    expect(ARIA_SRC).toMatch(/searchInput && searchInput\.value/);
  });
});

describe("#24 评审修复 — 跨库鲁棒性", () => {
  it("H4 dispatchMouseClick 补发 pointerdown/pointerup(Radix/Headless)", () => {
    expect(ARIA_SRC).toMatch(/new PointerEvent\("pointerdown"/);
    expect(ARIA_SRC).toMatch(/new PointerEvent\("pointerup"/);
  });
  it("H2 trigger 取第一个可见候选(避开 react-select 0×0 input)", () => {
    expect(ARIA_SRC).toMatch(/triggerCandidates\.find\(\(c\) => isVisible\(c\)\)/);
  });
  it("H3 per-label 选项等待 cap(unknown 不饿死后续 label)", () => {
    expect(ARIA_SRC).toMatch(/Math\.min\(remaining\(\), 3000\)/);
  });
  it("M1 findListbox 多弹层取离 trigger 最近", () => {
    expect(ARIA_SRC).toMatch(/bestD/);
  });
  it("M2 typeahead 仅对搜索式 input 写值 + 写前清空", () => {
    expect(ARIA_SRC).toMatch(/aria-autocomplete/);
    expect(ARIA_SRC).toMatch(/isSearchInput/);
    expect(ARIA_SRC).toMatch(/writeFilter\(""\)/);
  });
  it("H1 verify 纳入 input.value 证据 + exact 优先", () => {
    expect(ARIA_SRC).toMatch(/const inputValues = \(\)/);
    expect(ARIA_SRC).toMatch(/ivs\.some\(\(t\) => t === w\)/);
  });
  it("M3 verify 用 waitFor 轮询而非固定 sleep", () => {
    expect(ARIA_SRC).toMatch(/const allReflected = await waitFor\(/);
  });
});
