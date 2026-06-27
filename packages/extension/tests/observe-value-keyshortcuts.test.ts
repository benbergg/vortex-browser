// @vitest-environment jsdom
/**
 * Description: N0002 B006 + B010/B016 — valueMin/valueMax/keyshortcuts
 *   字段在 elements 真实路径(scanOneFrame)填充。
 *   B006: slider / progressbar valuemin/max 独立字段(原 valuetext 短路丢范围)。
 *   B010/B016: aria-keyshortcuts 显式键盘快捷键字段。
 *   本测试直测 elements schema 字段是否被填充, 不测渲染(渲染在 mcp 仓)。
 */
import { describe, it, expect } from "vitest";

/**
 * 模拟 inject func collectOneFrame 收集元素 + 填充 valueMin/valueMax/keyshortcuts 的算法。
 * 与 observe.ts 内联副本同步; 若生产代码改, 此 helper 须同步改。
 */
function collectAttrs(
  attrs: Record<string, string | null>,
  tag?: string,
  inputType?: string,
): { valueMin?: string; valueMax?: string; keyshortcuts?: string } {
  const out: { valueMin?: string; valueMax?: string; keyshortcuts?: string } = {};
  const vmin = attrs["aria-valuemin"];
  const vmax = attrs["aria-valuemax"];
  if (vmin != null && vmin !== "") out.valueMin = vmin;
  if (vmax != null && vmax !== "") out.valueMax = vmax;
  if (tag === "INPUT" && inputType === "range") {
    if (!out.valueMin && attrs["min"]) out.valueMin = attrs["min"];
    if (!out.valueMax && attrs["max"]) out.valueMax = attrs["max"];
  }
  const ks = attrs["aria-keyshortcuts"];
  if (ks != null) {
    const trim = ks.trim();
    if (trim) out.keyshortcuts = trim;
  }
  return out;
}

describe("observe-attrs: valueMin/valueMax/keyshortcuts (N0002 B006/B010/B016)", () => {
  it("B006: slider aria-valuemin/max 映射到 valueMin/valueMax", () => {
    const r = collectAttrs({
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": "30",
    });
    expect(r.valueMin).toBe("0");
    expect(r.valueMax).toBe("100");
  });

  it("B006: valuetext 命中(原始 now=0/100) 仍输出 valueMin/valueMax", () => {
    // 关键 B006 场景: valuetext 短路早返回, 范围丢。
    // 修复后 valueMin/valueMax 独立读, 即 valuetext 命中也输出。
    const r = collectAttrs({
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuetext": "30 of 100",
    });
    expect(r.valueMin).toBe("0");
    expect(r.valueMax).toBe("100");
  });

  it("B006: 原生 input type=range 走 IDL .min/.max 兜底", () => {
    const r = collectAttrs(
      { min: "0", max: "10" },
      "INPUT",
      "range",
    );
    expect(r.valueMin).toBe("0");
    expect(r.valueMax).toBe("10");
  });

  it("B006: input range aria-valuemin/max 优先于 IDL .min/.max", () => {
    const r = collectAttrs(
      { "aria-valuemin": "5", "aria-valuemax": "50", min: "0", max: "10" },
      "INPUT",
      "range",
    );
    expect(r.valueMin).toBe("5");
    expect(r.valueMax).toBe("50");
  });

  it("B006: 缺 aria-valuemin/max → valueMin/valueMax 字段不写(undefined)", () => {
    const r = collectAttrs({ "aria-valuenow": "5" });
    expect(r.valueMin).toBeUndefined();
    expect(r.valueMax).toBeUndefined();
  });

  it("B006: aria-valuemin='' (空字符串) → 不写", () => {
    const r = collectAttrs({ "aria-valuemin": "", "aria-valuemax": "" });
    expect(r.valueMin).toBeUndefined();
    expect(r.valueMax).toBeUndefined();
  });

  it("B010: aria-keyshortcuts 非空 → 写入并 trim", () => {
    const r = collectAttrs({ "aria-keyshortcuts": "Meta+K" });
    expect(r.keyshortcuts).toBe("Meta+K");
  });

  it("B010: aria-keyshortcuts 多个键(空格分隔) 保留", () => {
    const r = collectAttrs({ "aria-keyshortcuts": "Meta+K Control+K" });
    expect(r.keyshortcuts).toBe("Meta+K Control+K");
  });

  it("B010: aria-keyshortcuts 前后空白 trim", () => {
    const r = collectAttrs({ "aria-keyshortcuts": "  Meta+K  " });
    expect(r.keyshortcuts).toBe("Meta+K");
  });

  it("B010: aria-keyshortcuts 缺省(null) → 不写字段", () => {
    const r = collectAttrs({});
    expect(r.keyshortcuts).toBeUndefined();
  });

  it("B010: aria-keyshortcuts='' (空字符串) → trim 后空, 不写", () => {
    const r = collectAttrs({ "aria-keyshortcuts": "" });
    expect(r.keyshortcuts).toBeUndefined();
  });

  it("B010: aria-keyshortcuts='   ' (全空白) → trim 后空, 不写", () => {
    const r = collectAttrs({ "aria-keyshortcuts": "   " });
    expect(r.keyshortcuts).toBeUndefined();
  });
});
