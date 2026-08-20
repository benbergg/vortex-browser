// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { buildCorpus, checkStructure, DEFAULT_SHAPES } from "../src/runner/perf-corpus.js";
import type { CorpusShape } from "../src/perf-types.js";

// 生成器的节点数学不能只靠比字符串 —— 把建树脚本真跑进 jsdom,拿真实 DOM 对账。
// new Function 而不是直接 eval:复刻注入时丢模块作用域的环境,脚本必须自包含。
function runBuild(shape: CorpusShape): { domNodes: number; targets: number } {
  const plan = buildCorpus(shape);
  return new Function(`return ${plan.buildScript}`)() as { domNodes: number; targets: number };
}

describe("语料生成器的结构真值", () => {
  it.each([
    // 期望值手算:cards = max(ceil(targets/3), ceil((nodes-depth)/4))
    // domNodes = depth + cards*4(只数生成的子树)
    ["节点数占主导", { id: "a", nodes: 2000, depth: 20, targets: 50, painted: true }, 2000, 1],
    ["深度占主导", { id: "b", nodes: 2000, depth: 500, targets: 50, painted: false }, 2000, 503],
    ["目标数托底", { id: "c", nodes: 10, depth: 2, targets: 50, painted: false }, 70, 5],
  ])("%s", (_n, shape, domNodes, steps) => {
    const plan = buildCorpus(shape as CorpusShape);
    expect(plan.expect.domNodes).toBe(domNodes);
    expect(plan.expect.ancestorStepsPerTarget).toBe(steps);
  });

  it("建树脚本在真实 DOM 上跑出来的节点数与真值一致", () => {
    for (const shape of DEFAULT_SHAPES) {
      const actual = runBuild(shape);
      const plan = buildCorpus(shape);
      expect(actual.domNodes, `${shape.id} 节点数`).toBe(plan.expect.domNodes);
      expect(actual.targets, `${shape.id} 目标数`).toBeGreaterThanOrEqual(shape.targets);
    }
  });

  it("painted 决定 card 有没有底色 —— 它是上溯步数的唯一开关", () => {
    const on = buildCorpus({ id: "p", nodes: 100, depth: 5, targets: 3, painted: true });
    const off = buildCorpus({ id: "p", nodes: 100, depth: 5, targets: 3, painted: false });
    expect(on.buildScript).toContain("#ffffff");
    expect(off.buildScript).not.toContain("#ffffff");
    expect(on.expect.ancestorStepsPerTarget).toBe(1);
    expect(off.expect.ancestorStepsPerTarget).toBe(8); // 1 card + 5 depth + body + html
  });

  it.each([
    ["depth 为 0", { id: "x", nodes: 10, depth: 0, targets: 1, painted: true }],
    ["targets 为 0", { id: "x", nodes: 10, depth: 1, targets: 0, painted: true }],
  ])("%s 直接抛,不生成无意义语料", (_n, shape) => {
    expect(() => buildCorpus(shape as CorpusShape)).toThrow();
  });
});

describe("结构真值比对是压测唯一的红灯", () => {
  const plan = buildCorpus({ id: "s", nodes: 100, depth: 5, targets: 3, painted: false });

  it("一致时无红灯", () => {
    expect(checkStructure(plan, { domNodes: plan.expect.domNodes, ancestorStepsPerTarget: 8 })).toEqual([]);
  });

  it("节点数与步数各自独立报错,不互相掩盖", () => {
    const both = checkStructure(plan, { domNodes: 1, ancestorStepsPerTarget: 99 });
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("节点数");
    expect(both[1]).toContain("上溯步数");
    // 报错要带上期望与实测两个数字,否则读报告的人还得回来翻代码
    expect(both[0]).toContain(String(plan.expect.domNodes));
    expect(both[0]).toContain("1");
    expect(both[1]).toContain("99");
  });
});
