// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { buildCorpus, checkStructure, DEFAULT_SHAPES } from "../src/runner/perf-corpus.js";
import type { CorpusShape } from "../src/perf-types.js";

// 生成器的节点数学不能只靠比字符串 —— 把建树脚本真跑进 jsdom,拿真实 DOM 对账。
// new Function 而不是直接 eval:复刻注入时丢模块作用域的环境,脚本必须自包含。
function runBuild(shape: CorpusShape): {
  domNodes: number; targets: number; shadowRoots: number; maxNest: number;
  slotsUsed: number; ancestorStepsPerTarget: number;
} {
  const plan = buildCorpus(shape);
  return new Function(`return ${plan.buildScript}`)() as {
    domNodes: number; targets: number; shadowRoots: number; maxNest: number;
    slotsUsed: number; ancestorStepsPerTarget: number;
  };
}

describe("语料生成器的结构真值", () => {
  it.each([
    // 期望值手算:cards = max(ceil(targets/3), ceil((nodes-depth)/4))
    // domNodes = depth + cards*4(只数生成的子树)
    ["节点数占主导", { id: "a", nodes: 2000, depth: 20, targets: 50, painted: true }, 2000, 1, 0],
    ["深度占主导", { id: "b", nodes: 2000, depth: 500, targets: 50, painted: false }, 2000, 503, 0],
    ["目标数托底", { id: "c", nodes: 10, depth: 2, targets: 50, painted: false }, 70, 5, 0],
    // 链节点 = depth + hosts*nest;domNodes = 链节点 + cards*4
    ["shadow 广度", { id: "d", nodes: 4000, depth: 10, targets: 50, painted: true, shadow: { hosts: 200, nest: 1 } }, 4002, 1, 200],
    // 不上色 → 走完整条 composed 链:card(1) + nest 6 + depth 10 + body + html = 19
    ["shadow 嵌套不上色", { id: "e", nodes: 2000, depth: 10, targets: 50, painted: false, shadow: { hosts: 20, nest: 6 } }, 2002, 19, 120],
  ])("%s", (_n, shape, domNodes, steps, shadowRoots) => {
    const plan = buildCorpus(shape as CorpusShape);
    expect(plan.expect.domNodes).toBe(domNodes);
    expect(plan.expect.ancestorStepsPerTarget).toBe(steps);
    expect(plan.expect.shadowRoots).toBe(shadowRoots);
  });

  // 上溯走 el.parentElement,它不跨 shadow 边界 —— card 挂在 shadow root 上,
  // card.parentElement 即 null。所以 shadow 内目标的步数与 painted / depth 都无关。
  // 上溯走 composed 链,跨得过 shadow 边界 —— 所以 nest 会计进步数。
  // 走 parentElement 的老写法在 shadow 边界就断,这三条会全是 1。
  it("shadow 内目标的上溯步数把 nest 与 depth 都算进去", () => {
    const mk = (painted: boolean, depth: number, nest: number) =>
      buildCorpus({ id: "s", nodes: 500, depth, targets: 3, painted, shadow: { hosts: 2, nest } })
        .expect.ancestorStepsPerTarget;
    expect(mk(true, 5, 2)).toBe(1); // card 有底色,第一步就 break
    expect(mk(false, 5, 2)).toBe(1 + 2 + 5 + 2);
    expect(mk(false, 5, 6)).toBe(1 + 6 + 5 + 2); // 只有 nest 变
    expect(mk(false, 300, 2)).toBe(1 + 2 + 300 + 2);
  });

  it("建树脚本在真实 DOM 上跑出来的节点数与 shadow root 数都与真值一致", () => {
    for (const shape of DEFAULT_SHAPES) {
      const actual = runBuild(shape);
      const plan = buildCorpus(shape);
      expect(actual.domNodes, `${shape.id} 节点数`).toBe(plan.expect.domNodes);
      expect(actual.shadowRoots, `${shape.id} shadow root 数`).toBe(plan.expect.shadowRoots);
      expect(actual.maxNest, `${shape.id} 嵌套层数`).toBe(plan.expect.maxNest);
      expect(actual.slotsUsed, `${shape.id} 装 card 的容器数`).toBe(plan.expect.slotsUsed);
      // 上溯步数此前只在真机上量,现在建树脚本自己走一遍 composed 链,离线就能核
      expect(actual.ancestorStepsPerTarget, `${shape.id} 上溯步数`)
        .toBe(plan.expect.ancestorStepsPerTarget);
      expect(actual.targets, `${shape.id} 目标数`).toBeGreaterThanOrEqual(shape.targets);
    }
  });

  // shadow 形状的目标全在 shadow 里,document.querySelectorAll 一个都看不见 ——
  // 观测侧忘了深走查就会得出"语料没生成"的错误结论。
  it("shadow 形状的目标 light-DOM 查询一个都看不到,深走查才拿得全", () => {
    const shape: CorpusShape = { id: "s", nodes: 400, depth: 4, targets: 9, painted: true, shadow: { hosts: 3, nest: 2 } };
    const actual = runBuild(shape);
    expect(document.querySelectorAll(".t").length).toBe(0);
    expect(actual.targets).toBeGreaterThanOrEqual(9);
    expect(actual.shadowRoots).toBe(6);
  });

  // 只数 shadow root 个数验证不了嵌套:把 6 层嵌套摊平成 6 个并列 host,个数和节点数都不变。
  it("嵌套层数是独立真值,摊平成并列时它才会现形", () => {
    const nested = runBuild({ id: "n", nodes: 400, depth: 4, targets: 3, painted: true, shadow: { hosts: 2, nest: 6 } });
    const flat = runBuild({ id: "f", nodes: 400, depth: 4, targets: 3, painted: true, shadow: { hosts: 12, nest: 1 } });
    expect(nested.shadowRoots).toBe(12);
    expect(flat.shadowRoots).toBe(12); // 个数一样
    expect(nested.maxNest).toBe(6);
    expect(flat.maxNest).toBe(1); // 只有这一项分得开
  });

  // card 全塞进第一个 host 时,节点数与 shadow root 数都不变 —— 只有这项能发现
  it("card 摊到每个 host,不是全塞第一个", () => {
    const a = runBuild({ id: "sp", nodes: 800, depth: 4, targets: 30, painted: true, shadow: { hosts: 8, nest: 1 } });
    expect(a.slotsUsed).toBe(8);
    // 容器比 card 还多时,以 card 数为准
    const b = buildCorpus({ id: "sp2", nodes: 10, depth: 2, targets: 3, painted: true, shadow: { hosts: 50, nest: 1 } });
    expect(b.expect.slotsUsed).toBeLessThanOrEqual(50);
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
    ["shadow.hosts 为 0", { id: "x", nodes: 10, depth: 1, targets: 1, painted: true, shadow: { hosts: 0, nest: 1 } }],
    ["shadow.nest 为 0", { id: "x", nodes: 10, depth: 1, targets: 1, painted: true, shadow: { hosts: 1, nest: 0 } }],
  ])("%s 直接抛,不生成无意义语料", (_n, shape) => {
    expect(() => buildCorpus(shape as CorpusShape)).toThrow();
  });
});

describe("结构真值比对是压测唯一的红灯", () => {
  const plan = buildCorpus({ id: "s", nodes: 100, depth: 5, targets: 3, painted: false });

  it("一致时无红灯", () => {
    expect(checkStructure(plan, { domNodes: plan.expect.domNodes, ancestorStepsPerTarget: 8, shadowRoots: 0, maxNest: 0, slotsUsed: 1 })).toEqual([]);
  });

  it("节点数与步数各自独立报错,不互相掩盖", () => {
    const both = checkStructure(plan, { domNodes: 1, ancestorStepsPerTarget: 99, shadowRoots: 7, maxNest: 2, slotsUsed: 9 });
    expect(both).toHaveLength(5);
    expect(both[0]).toContain("节点数");
    expect(both[1]).toContain("上溯步数");
    // 报错要带上期望与实测两个数字,否则读报告的人还得回来翻代码
    expect(both[0]).toContain(String(plan.expect.domNodes));
    expect(both[0]).toContain("1");
    expect(both[1]).toContain("99");
    expect(both[2]).toContain("shadow root 数");
    expect(both[2]).toContain("7");
    expect(both[3]).toContain("嵌套层数");
    expect(both[4]).toContain("装了 card 的容器数");
  });
});
