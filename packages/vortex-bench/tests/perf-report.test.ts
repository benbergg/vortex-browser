import { describe, it, expect } from "vitest";
import {
  median,
  spread,
  rankDimensions,
  renderPerfReport,
  collectMismatches,
} from "../src/perf-report.js";
import type { PerfReport, PerfRun } from "../src/perf-types.js";

const run = (over: Partial<PerfRun> = {}): PerfRun => ({
  shapeId: "stress-40k",
  domNodes: 40002,
  matched: 588,
  samples: [
    { dimension: "text", msSamples: [90, 94, 92], hitTests: 0, ancestorSteps: 0 },
    { dimension: "geometry", msSamples: [140, 132, 150], hitTests: 50, ancestorSteps: 0 },
    { dimension: "contrast", msSamples: [110, 108, 112], hitTests: 0, ancestorSteps: 1650 },
  ],
  structuralMismatches: [],
  ...over,
});

describe("统计量", () => {
  it("奇偶个样本都取中位数,不退化成均值", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    // 均值会被离群值拉走,中位数不会 —— 这正是选它的理由
    expect(median([1, 1, 1, 100])).toBe(1);
  });

  it("空样本不炸", () => {
    expect(median([])).toBe(0);
    expect(spread([])).toBe(0);
  });

  it("抖动是最慢比最快", () => {
    expect(spread([96, 132])).toBe(1.4);
    expect(spread([100, 100])).toBe(1);
  });
});

describe("成本次序", () => {
  it("差距远大于抖动时给出确定次序", () => {
    // 140 / 110 = 1.27 vs 抖动 1.1/1.0 → 分得开;110 / 92 = 1.2 vs 1.0 → 也分得开
    expect(rankDimensions(run())).toEqual(["geometry", "contrast", "text"]);
  });

  it("差距小于抖动时并列,不假装排得出先后", () => {
    const noisy = run({
      samples: [
        { dimension: "box", msSamples: [200, 253, 300], hitTests: 0, ancestorSteps: 0 },
        { dimension: "geometry", msSamples: [150, 200, 260], hitTests: 50, ancestorSteps: 0 },
        { dimension: "text", msSamples: [20, 21, 22], hitTests: 0, ancestorSteps: 0 },
      ],
    });
    // 253 / 200 = 1.27,小于两者抖动(1.5 / 1.7) → 并列;text 差一个量级 → 分得开
    expect(rankDimensions(noisy)).toEqual(["box~geometry", "text"]);
  });
});

describe("报告渲染", () => {
  const report: PerfReport = {
    generatedAt: "2026-08-20T00:00:00.000Z",
    browser: "Chrome/151.0.0.0",
    runs: [run()],
  };

  it("表里给出确定量,并写明耗时不作判据", () => {
    const md = renderPerfReport(report);
    expect(md).toContain("| geometry | 140.0 |");
    expect(md).toContain("| 50 | 0 |"); // geometry 的命中测试次数/上溯步数
    expect(md).toContain("| 0 | 1650 |"); // contrast 反过来
    expect(md).toContain("参考量");
    expect(md).toContain("geometry > contrast > text");
  });

  it("无红灯时不出现红灯段落 —— 免得读者以为有问题", () => {
    expect(renderPerfReport(report)).not.toContain("结构真值不符");
  });

  it("有红灯时逐条列出并可被汇总", () => {
    const bad: PerfReport = { ...report, runs: [run({ structuralMismatches: ["[x] 节点数 期望 1 实测 2"] })] };
    expect(renderPerfReport(bad)).toContain("结构真值不符");
    expect(renderPerfReport(bad)).toContain("[x] 节点数 期望 1 实测 2");
    expect(collectMismatches(bad)).toEqual(["[x] 节点数 期望 1 实测 2"]);
  });

  it("退出码只看结构红灯,耗时再难看也不算失败", () => {
    const slow: PerfReport = {
      ...report,
      runs: [run({ samples: [{ dimension: "geometry", msSamples: [9999], hitTests: 50, ancestorSteps: 0 }] })],
    };
    expect(collectMismatches(slow)).toEqual([]);
  });
});
