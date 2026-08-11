/**
 * Author: qingwa
 * Description: debug_read 空结果自陈 —— 区分「确实没有」和「过滤削光了」。
 *
 * 基线(2026-08-11)里 debug_read 48.5% 的调用成功且返回 `[]`,调用方无从判断该
 * 放宽 filter 还是该先复现一次动作,于是反复微调 pattern 重试。两条真因:
 *  ① console/network 都是懒订阅,首次调用**当场**才开始录,此前的日志根本没进缓冲区;
 *  ② network 的 pattern 是 `url.includes()` 子串匹配,而实测传进来的是
 *     `header|column|query|table` / `.*` 这类正则写法 —— 逐字匹配必然零命中。
 */

import { describe, it, expect } from "vitest";
import { diagnoseEmptyConsole, diagnoseEmptyNetwork } from "../src/lib/empty-diagnosis.js";

describe("diagnoseEmptyConsole", () => {
  it("本次调用才开始录时，指出更早的日志从未被捕获", () => {
    const d = diagnoseEmptyConsole({ justSubscribed: true, buffered: 0 });
    expect(d).toMatch(/started with this call/i);
    expect(d).toMatch(/reload|reproduce/i);
  });

  it("早已在录且缓冲区为空 = 真的没有日志，不该再调 filter", () => {
    const d = diagnoseEmptyConsole({ justSubscribed: false, buffered: 0 });
    expect(d).toMatch(/empty/i);
    expect(d).not.toMatch(/started with this call/i);
  });

  it("缓冲区有内容却返回空 = level 滤光了，报出被滤掉的条数", () => {
    const d = diagnoseEmptyConsole({ justSubscribed: false, buffered: 128, level: "error" });
    expect(d).toContain("128");
    expect(d).toContain("error");
    expect(d).toMatch(/level/i);
  });

  it("tail=0 是自找的空，单独点破", () => {
    const d = diagnoseEmptyConsole({ justSubscribed: false, buffered: 12, limit: 0 });
    expect(d).toMatch(/tail=0/);
  });
});

describe("diagnoseEmptyNetwork", () => {
  const base = {
    justSubscribed: false,
    buffered: 0,
    afterTypeFilter: 0,
    afterPattern: 0,
    afterStatus: 0,
    includeResources: false,
  };

  it("本次调用才 attach 时，说明此前的请求只剩 Resource Timing 摘要", () => {
    const d = diagnoseEmptyNetwork({ ...base, justSubscribed: true });
    expect(d).toMatch(/started with this call/i);
    expect(d).toMatch(/Resource Timing/i);
  });

  it("全被 API 类过滤削光时，指路 includeResources", () => {
    const d = diagnoseEmptyNetwork({ ...base, buffered: 40, afterTypeFilter: 0 });
    expect(d).toContain("40");
    expect(d).toContain("includeResources");
  });

  it("pattern 削光时报出子串语义与剩余条数", () => {
    const d = diagnoseEmptyNetwork({
      ...base,
      buffered: 40,
      afterTypeFilter: 22,
      afterPattern: 0,
      pattern: "voc/task/query",
    });
    expect(d).toContain("22");
    expect(d).toContain("voc/task/query");
    expect(d).toMatch(/substring/i);
  });

  it("pattern 写成正则时明确点破 —— 基线里 8/10 次网络空返回是这个", () => {
    for (const p of ["header|column|query|table", ".*", "exec|sql|query"]) {
      const d = diagnoseEmptyNetwork({ ...base, buffered: 40, afterTypeFilter: 22, afterPattern: 0, pattern: p });
      expect(d, p).toMatch(/not a regex|literally/i);
    }
  });

  it("普通子串不误报正则提示", () => {
    const d = diagnoseEmptyNetwork({
      ...base, buffered: 40, afterTypeFilter: 22, afterPattern: 0, pattern: "/api/order",
    });
    expect(d).not.toMatch(/not a regex/i);
  });

  it("status 区间削光时报出被滤掉的条数与区间", () => {
    const d = diagnoseEmptyNetwork({
      ...base, buffered: 40, afterTypeFilter: 22, afterPattern: 18, afterStatus: 0, statusMin: 400,
    });
    expect(d).toContain("18");
    expect(d).toContain("400");
    expect(d).toMatch(/status/i);
  });

  it("每级都还有剩、只有 tail 削光时指出 tail", () => {
    const d = diagnoseEmptyNetwork({
      ...base, buffered: 40, afterTypeFilter: 22, afterPattern: 18, afterStatus: 18, limit: 0,
    });
    expect(d).toMatch(/tail=0/);
  });

  it("任何输入都给出非空的一行", () => {
    expect(diagnoseEmptyNetwork(base).trim().length).toBeGreaterThan(10);
    expect(diagnoseEmptyConsole({ justSubscribed: false, buffered: 0 }).trim().length).toBeGreaterThan(10);
  });
});
