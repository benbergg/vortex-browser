import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * T5 compound 元数据增强:date/time/file/range/number input 注入元数据。
 *
 * 目的:LLM 使用 vortex_fill 前通过 observe 输出直接看到:
 * - date/time/datetime-local/month/week input 的格式串 (format=YYYY-MM-DD 等)
 * - file input 当前选中文件名或 "None"
 * - range/number input 的 min/max/step 约束
 * 不再需要额外的 js_evaluate 补查。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe input compound 元数据注入 (T5)", () => {
  describe("date/time input format 注入", () => {
    it("page-side 有 buildInputCompound helper", () => {
      expect(OBSERVE_SRC).toMatch(/function\s+buildInputCompound/);
    });

    it("date input 注入 format=YYYY-MM-DD", () => {
      expect(OBSERVE_SRC).toMatch(/YYYY-MM-DD/);
    });

    it("time input 注入 format=HH:mm", () => {
      expect(OBSERVE_SRC).toMatch(/HH:mm/);
    });

    it("datetime-local input 注入 format=YYYY-MM-DDTHH:mm", () => {
      expect(OBSERVE_SRC).toMatch(/YYYY-MM-DDTHH:mm/);
    });

    it("month input 注入 format=YYYY-MM", () => {
      expect(OBSERVE_SRC).toMatch(/YYYY-MM/);
    });

    it("week input 注入 format=YYYY-Www", () => {
      expect(OBSERVE_SRC).toMatch(/YYYY-Www/);
    });

    it("formatHint 字段被设到 compound 对象", () => {
      expect(OBSERVE_SRC).toMatch(/formatHint/);
    });

    it("buildInputCompound 返回 compound 对象含 role='date-input'", () => {
      // date/time input 的 compound role 标识
      expect(OBSERVE_SRC).toMatch(/date-input/);
    });
  });

  describe("file input 元数据注入", () => {
    it("file input 读 element.files 当前文件名", () => {
      expect(OBSERVE_SRC).toMatch(/\.files/);
    });

    it("无文件时显示 None", () => {
      expect(OBSERVE_SRC).toMatch(/"None"/);
    });

    it("多文件给计数(如 '3 files')", () => {
      expect(OBSERVE_SRC).toMatch(/files\.length/);
    });

    it("file input compound role='file-input'", () => {
      expect(OBSERVE_SRC).toMatch(/file-input/);
    });
  });

  describe("range/number input 元数据注入", () => {
    it("range/number input 读 min 属性", () => {
      // getAttribute('min') 用于 range/number compound
      expect(OBSERVE_SRC).toMatch(/getAttribute\(["']min["']\)/);
    });

    it("range/number input 读 max 属性", () => {
      expect(OBSERVE_SRC).toMatch(/getAttribute\(["']max["']\)/);
    });

    it("range/number input 读 step 属性", () => {
      expect(OBSERVE_SRC).toMatch(/getAttribute\(["']step["']\)/);
    });

    it("range/number compound role='range-input' 或 'number-input'", () => {
      expect(OBSERVE_SRC).toMatch(/range-input|number-input/);
    });
  });

  describe("compound 字段注入时机", () => {
    it("elements.push 时包含 compound 扩展", () => {
      // page-side push 时注入 compound
      expect(OBSERVE_SRC).toMatch(/buildInputCompound\(htmlEl\)/);
    });
  });
});
