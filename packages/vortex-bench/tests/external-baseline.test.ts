import { describe, it, expect } from "vitest";
import { summarize, type BaselineSample } from "../src/runner/external-baseline.js";

/**
 * 外部基线对照的聚合逻辑单测。
 *
 * 存在的意义:vortex 一直只用自家 bench 自证,历史上多次出现"自闭环判断→假绿"
 * (MUI 8 报 0 真、班牛 15 报 1 真)。对照 chrome-devtools-mcp 是外部锚点,
 * 但两边浏览器不是同一个,任何数字都不能当 parity 引用 —— summarize 必须恒带 caveat。
 */
describe("summarize", () => {
  const samples: BaselineSample[] = [
    { tool: "vortex", page: "/a", bytes: 1000, durationMs: 100, ok: true },
    { tool: "vortex", page: "/b", bytes: 2000, durationMs: 300, ok: true },
    { tool: "chrome-devtools-mcp", page: "/a", bytes: 5000, durationMs: 200, ok: true },
    { tool: "chrome-devtools-mcp", page: "/b", bytes: 7000, durationMs: 400, ok: false, error: "boom" },
  ];

  it("按工具聚合字节与耗时，失败样本计入 failures 且不进均值", () => {
    const s = summarize(samples);
    expect(s.tools["vortex"]).toMatchObject({ pages: 2, failures: 0, totalBytes: 3000, avgDurationMs: 200 });
    expect(s.tools["chrome-devtools-mcp"]).toMatchObject({ pages: 2, failures: 1, totalBytes: 5000, avgDurationMs: 200 });
  });

  it("报告恒带环境不对等声明，防止被当成 parity 数字引用", () => {
    expect(summarize(samples).caveat).toMatch(/不对等|not comparable/);
  });

  it("全部失败时均值为 0 而不是 NaN", () => {
    const s = summarize([{ tool: "x", page: "/a", bytes: 0, durationMs: 500, ok: false, error: "e" }]);
    expect(s.tools["x"]).toMatchObject({ pages: 1, failures: 1, totalBytes: 0, avgDurationMs: 0 });
  });

  it("空样本不抛，仍带 caveat", () => {
    const s = summarize([]);
    expect(s.tools).toEqual({});
    expect(s.caveat).toBeTruthy();
  });
});
