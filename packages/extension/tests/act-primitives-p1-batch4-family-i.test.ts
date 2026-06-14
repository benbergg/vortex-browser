import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:act 原语白盒审计批次 4 —— 族 I(widget driver 覆盖与等待)。
 * 让现有 select/checkbox-group 驱动 + 原生 <select> 抗住三类「误报错」:
 *  #25 label 含图标/换行的内部空白 → 严格 === 判 Unknown(改 norm 折叠空白)
 *  #23 原生 <select> 选项 Ajax 异步填充,同步枚举一次 → NO_MATCHING_OPTION(改轮询重读 el.options)
 *  #22 el-select remote/懒加载选项首帧空 → Unknown option(改 waitFor 等选项出现)
 *  #21 el-select 点 .is-disabled 项无效 → verify 报含糊 COMMIT_FAILED(改 find 跳过禁用 + 命中禁用直接报 disabled)
 * page-side inline func / IIFE 不可 import,source-grep 守护;真实行为 live 验证(报告 §27)。
 * 2026-06-03 act 原语白盒审计。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");
const SEL_SRC = readFileSync(
  join(__dirname, "../src/page-side/commit-drivers/select.ts"),
  "utf8",
);
const CB_SRC = readFileSync(
  join(__dirname, "../src/page-side/commit-drivers/checkbox-group.ts"),
  "utf8",
);

// 原生 SELECT handler 区间
const selectIdx = DOM_SRC.indexOf("[DomActions.SELECT]");
const SELECT_BLOCK = DOM_SRC.slice(selectIdx, selectIdx + 9200);

describe("族 I #25 — checkbox-group label 折叠内部空白匹配", () => {
  it("不再用 (b.innerText||\"\").trim() === name 严格等值", () => {
    expect(CB_SRC).not.toMatch(/\(b\.innerText \|\| ""\)\.trim\(\) === name/);
  });
  it("定义 norm 折叠 \\s+ 为单空格", () => {
    expect(CB_SRC).toMatch(/replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  });
  it("label 与 innerText 匹配两侧都过 norm", () => {
    expect(CB_SRC).toMatch(/norm\(b\.innerText/);
  });
});

describe("族 I #23 — 原生 <select> 轮询等异步选项", () => {
  it("SELECT inline func 改 async", () => {
    expect(SELECT_BLOCK).toMatch(/async \(sel: string, val: string \| string\[\], timeoutMs: number\)/);
  });
  it("有 allMatchable 判定与轮询重读 el.options", () => {
    expect(SELECT_BLOCK).toMatch(/allMatchable/);
    expect(SELECT_BLOCK).toMatch(/opts = Array\.from\(el\.options\)/);
  });
  it("把 timeoutMs 传入 inline func", () => {
    expect(SELECT_BLOCK).toMatch(/\[selector, value, .*timeout/);
  });
});

describe("族 I #22 — el-select 等 remote/懒加载选项出现", () => {
  it("选项匹配用 waitFor 轮询而非一次性枚举", () => {
    // run() 内 per-label 匹配应在 waitFor 中重算 querySelectorAll
    const labelLoopIdx = SEL_SRC.indexOf("for (const label of labels)");
    const loopBlock = SEL_SRC.slice(labelLoopIdx, labelLoopIdx + 1400);
    expect(loopBlock).toMatch(/await waitFor\(/);
  });
});

describe("族 I #21 — el-select 跳过禁用项 + 明确 disabled 报错", () => {
  it("find 排除 .is-disabled", () => {
    expect(SEL_SRC).toMatch(/!\s*\w+\.classList\.contains\("is-disabled"\)/);
  });
  it("命中文本但禁用时报明确 disabled 错误", () => {
    expect(SEL_SRC).toMatch(/is disabled and cannot be selected/);
  });
  it("el-select 选项匹配也过 norm(同 #25 空白折叠)", () => {
    expect(SEL_SRC).toMatch(/norm\(.*textContent/);
  });
});

describe("族 I #21(评审补全)— 原生 <select> disabled option 不假成功", () => {
  it("单值路径命中 disabled option 报 INVALID_PARAMS", () => {
    expect(SELECT_BLOCK).toMatch(/opt\.disabled/);
    expect(SELECT_BLOCK).toMatch(/is disabled and cannot be selected/);
  });
  it("多选路径排除 disabled 命中项再报错", () => {
    expect(SELECT_BLOCK).toMatch(/disabledMatched/);
  });
});

describe("评审修复 — el-select 共享超时 deadline + verify 口径对齐", () => {
  it("per-label 等待从共享 deadline 扣减(remaining)而非各自 cap", () => {
    expect(SEL_SRC).toMatch(/const remaining = \(\) =>/);
    expect(SEL_SRC).toMatch(/const optWait = remaining\(\)/);
    expect(SEL_SRC).not.toMatch(/Math\.min\(timeoutMs, 3000\)/);
  });
  it("verify 的 label 也过 norm(R1-MEDIUM)", () => {
    expect(SEL_SRC).toMatch(/const w = norm\(l\)/);
    expect(SEL_SRC).toMatch(/displayed\.includes\(norm\(l\)\)/);
  });
});

describe("B3 — kind=select 命中原生 <select> 给友好指引(2026-06-14 selenium dogfood)", () => {
  it("识别原生 select(isNativeSelect:tagName/closest/querySelector)", () => {
    expect(SEL_SRC).toMatch(/isNativeSelect/);
    expect(SEL_SRC).toMatch(/target\.tagName === "SELECT"/);
  });
  it("原生 select 报指引用 action select / fill_form 不带 kind,而非 .el-select 不匹配", () => {
    expect(SEL_SRC).toMatch(/native <select>/);
    expect(SEL_SRC).toMatch(/action "select"/);
    expect(SEL_SRC).toMatch(/without kind/);
  });
});
