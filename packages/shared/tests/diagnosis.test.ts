/**
 * Author: qingwa
 * Description: 空结果自陈信道 —— 附加自陈不得改变非空结果的形状。
 */

import { describe, it, expect } from "vitest";
import { DIAGNOSIS_KEY, withDiagnosis, splitDiagnosis } from "../src/diagnosis.js";

describe("withDiagnosis", () => {
  it("没有自陈时原样返回同一个引用（非空结果零开销的硬保证）", () => {
    const logs = [{ level: "error" }];
    expect(withDiagnosis(logs, null)).toBe(logs);
    expect(withDiagnosis(logs, undefined)).toBe(logs);
    expect(withDiagnosis(logs, "")).toBe(logs);
    expect(withDiagnosis(logs, "   ")).toBe(logs);
  });

  it("有自陈时包一层，原值不被改写", () => {
    const logs: unknown[] = [];
    const out = withDiagnosis(logs, "buffer 是空的");
    expect(out).not.toBe(logs);
    expect(logs).toEqual([]);
    expect((out as Record<string, unknown>)[DIAGNOSIS_KEY]).toBe("buffer 是空的");
  });

  it("能包裹任意载荷类型（含 null / 0 / false）", () => {
    for (const v of [null, 0, false, "", [], {}]) {
      expect(splitDiagnosis(withDiagnosis(v, "why")).value).toEqual(v);
    }
  });
});

describe("splitDiagnosis", () => {
  it("往返还原", () => {
    const value = { total: 0, matches: [] };
    const { value: back, diagnosis } = splitDiagnosis(withDiagnosis(value, "扫了 0 个字符"));
    expect(back).toEqual(value);
    expect(diagnosis).toBe("扫了 0 个字符");
  });

  it("未包裹的结果原样透传，diagnosis 为 null", () => {
    const raw = [1, 2, 3];
    const { value, diagnosis } = splitDiagnosis(raw);
    expect(value).toBe(raw);
    expect(diagnosis).toBeNull();
  });

  it("恰好带 value 字段但没有自陈键的对象不被误拆", () => {
    const raw = { value: "abc" };
    expect(splitDiagnosis(raw).value).toBe(raw);
    expect(splitDiagnosis(raw).diagnosis).toBeNull();
  });

  it("自陈键存在但不是字符串时按未包裹处理（不臆造）", () => {
    const raw = { [DIAGNOSIS_KEY]: 42, value: "abc" };
    expect(splitDiagnosis(raw).value).toBe(raw);
    expect(splitDiagnosis(raw).diagnosis).toBeNull();
  });

  it("undefined / 原始值不炸", () => {
    expect(splitDiagnosis(undefined)).toEqual({ value: undefined, diagnosis: null });
    expect(splitDiagnosis("hi")).toEqual({ value: "hi", diagnosis: null });
  });
});
