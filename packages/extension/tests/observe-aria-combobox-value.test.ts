// ARIA combobox 的当前值兜底(2026-08-11 日志 + live A/B 实证)。
//
// 日志实测:121 次真实 observe 的 98 个 combobox 中,主 frame 52 个有 48 个带 value,
// 而 **iframe 内 46 个无一带 value**、91% 名值皆无 —— agent 拿到
// `combobox [ref=@x:f132e31] [haspopup:listbox] controls=#el-id-6620-1233`,
// 完全不知道这是什么下拉、当前选了什么。
//
// live A/B 确认机制:同一份 el-select DOM,放主 frame 得 value="主frame 20条/页",
// 放 iframe 得空 —— 因为 combobox 的 value 只来自 AX 覆盖层,而覆盖层写死
// `scans.find(s => s.frameId === 0)`(observe.ts),iframe 只有页面侧启发式,
// 而 getValueInfo 的 VALUE_ROLES 不含 combobox → 一路返回 undefined。
//
// 修法:页面侧给非原生 combobox 补「显示文本即当前值」的兜底。全 frame 生效,
// 不依赖 CDP;主 frame 若 AX 有值仍以 AX 为准(applyOverlay 的
// `if (ov.valueNow !== undefined)` 守卫保证兜底不被空值抹掉)。
//
// 本函数是纯决策(文本由调用方传入,提取逻辑 visibleTextContent 另有测试),
// 便于喂真实断言而非 mock executeScript。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ariaComboboxValue } from "../src/handlers/observe.js";

describe("ariaComboboxValue", () => {
  it("非原生 combobox 用显示文本当当前值", () => {
    expect(ariaComboboxValue("combobox", "DIV", "20条/页")).toBe("20条/页");
  });

  it("原生 <select> 不接管:既有 selectedOptions 路径更准", () => {
    expect(ariaComboboxValue("combobox", "SELECT", "选项A选项B选项C")).toBeUndefined();
  });

  it("原生 <input> 不接管:其 IDL value 才是真值", () => {
    expect(ariaComboboxValue("combobox", "INPUT", "占位文本")).toBeUndefined();
  });

  it("非 combobox 角色一律不接管", () => {
    expect(ariaComboboxValue("button", "DIV", "提交")).toBeUndefined();
    expect(ariaComboboxValue("listbox", "DIV", "甲乙丙")).toBeUndefined();
  });

  it("空文本/纯空白 → undefined,不产生噪声空值", () => {
    expect(ariaComboboxValue("combobox", "DIV", "")).toBeUndefined();
    expect(ariaComboboxValue("combobox", "DIV", "   \n  ")).toBeUndefined();
  });

  it("折叠空白:换行/多空格归一为单空格", () => {
    expect(ariaComboboxValue("combobox", "DIV", "近 7 天\n  ▾")).toBe("近 7 天 ▾");
  });

  it("截断到 80 字,防止大容器文本撑爆 observe 输出", () => {
    const out = ariaComboboxValue("combobox", "DIV", "长".repeat(200));
    expect(out).toHaveLength(80);
  });

  it("tag 大小写不敏感(注入侧 tag 为小写)", () => {
    expect(ariaComboboxValue("combobox", "select", "x")).toBeUndefined();
    expect(ariaComboboxValue("combobox", "div", "已启用")).toBe("已启用");
  });
});

describe("inject func 内联接入(源码锁,改一处须同步)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );

  it("getValueInfo 在 VALUE_ROLES 门之前调用了 combobox 兜底", () => {
    const idxCall = SRC.indexOf("__ariaComboboxValue(");
    const idxGate = SRC.indexOf("if (!VALUE_ROLES.has(role) && !isNativeValue) return undefined;");
    expect(idxCall).toBeGreaterThan(-1);
    expect(idxGate).toBeGreaterThan(-1);
    // 兜底必须先于 VALUE_ROLES 门,否则 combobox 会在门上被直接 return undefined
    expect(idxCall).toBeLessThan(idxGate);
  });
});
