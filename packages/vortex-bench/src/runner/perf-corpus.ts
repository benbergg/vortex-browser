// 深 DOM 压测语料生成器。纯函数:形状 → 建树脚本 + 结构真值,离线可测。
// 语料在页内用脚本现造而不落 HTML 文件,省掉一套静态服务,也保证每轮起点一致。

import type { CorpusShape, CorpusPlan } from "../perf-types.js";

/** 每个 card 固定 4 个节点:card 本身 + span + a + input */
const NODES_PER_CARD = 4;
const TARGETS_PER_CARD = 3;

/**
 * 默认形状集:两个真站量级 + 一个压力点 + 一个最坏上溯。
 * 真站校准 —— en.wikipedia.org 5413 节点/深 21,github.com 2391 节点/深 37。
 * 40k 是压力点不是真实上界,深 500 是病态最坏情况,都不代表真站。
 */
export const DEFAULT_SHAPES: readonly CorpusShape[] = [
  { id: "realistic-2k", nodes: 2000, depth: 20, targets: 50, painted: true },
  { id: "realistic-10k", nodes: 10000, depth: 30, targets: 50, painted: true },
  { id: "stress-40k", nodes: 40000, depth: 30, targets: 50, painted: false },
  { id: "pathological-deep", nodes: 2000, depth: 500, targets: 50, painted: false },
];

/**
 * 算这份语料生成后的真实节点数。
 * 主链 depth 个 div + 若干 card,card 数按补足 nodes 取整,至少放得下 targets。
 */
function planCounts(shape: CorpusShape): { cards: number; domNodes: number } {
  const needForTargets = Math.ceil(shape.targets / TARGETS_PER_CARD);
  const needForNodes = Math.ceil(Math.max(0, shape.nodes - shape.depth) / NODES_PER_CARD);
  const cards = Math.max(needForTargets, needForNodes);
  // 只数自己造的子树:落脚页 head 里有多少 meta/script 不该进真值
  return { cards, domNodes: shape.depth + cards * NODES_PER_CARD };
}

/**
 * contrast 每个目标元素要走的祖先步数。
 * painted 时最近祖先(card)就有底色,第一步即 break;否则一路走到 html 都找不到绘制背景,
 * 步数 = card + 主链 depth + body + html。
 */
function ancestorSteps(shape: CorpusShape): number {
  return shape.painted ? 1 : 1 + shape.depth + 2;
}

/** 形状 → 可在页内直接 eval 的建树脚本 + 结构真值 */
export function buildCorpus(shape: CorpusShape): CorpusPlan {
  if (shape.depth < 1) throw new Error(`depth 必须 >= 1: ${shape.id}`);
  if (shape.targets < 1) throw new Error(`targets 必须 >= 1: ${shape.id}`);
  const { cards, domNodes } = planCounts(shape);
  const cardBg = shape.painted ? '"#ffffff"' : '""';

  const buildScript = `(function(){
  // 钉死 html/body 透明:否则上溯步数真值取决于落脚页有没有设背景,换页就崩
  document.documentElement.style.backgroundColor = "transparent";
  document.body.style.backgroundColor = "transparent";
  document.body.innerHTML = "";
  var root = document.createElement("div"), cur = root;
  for (var i = 1; i < ${shape.depth}; i++) { var d = document.createElement("div"); cur.appendChild(d); cur = d; }
  for (var c = 0; c < ${cards}; c++) {
    var card = document.createElement("div");
    card.className = "card";
    if (${cardBg}) card.style.backgroundColor = ${cardBg};
    card.innerHTML = '<span class="t">label</span><a class="t" href="/x">link</a><input class="t" value="v">';
    cur.appendChild(card);
  }
  document.body.appendChild(root);
  document.body.getBoundingClientRect();
  return { domNodes: root.querySelectorAll("*").length + 1, pageNodes: document.querySelectorAll("*").length,
           targets: document.querySelectorAll(".t").length };
})()`;

  return {
    shape,
    buildScript,
    expect: { domNodes, ancestorStepsPerTarget: ancestorSteps(shape) },
  };
}

/** 结构真值比对。返回空数组表示语料如预期生成 —— 这是压测里唯一可阻断的判据。 */
export function checkStructure(
  plan: CorpusPlan,
  observed: { domNodes: number; ancestorStepsPerTarget: number },
): string[] {
  const out: string[] = [];
  if (observed.domNodes !== plan.expect.domNodes) {
    out.push(
      `[${plan.shape.id}] 节点数 期望 ${plan.expect.domNodes} 实测 ${observed.domNodes}`,
    );
  }
  if (observed.ancestorStepsPerTarget !== plan.expect.ancestorStepsPerTarget) {
    out.push(
      `[${plan.shape.id}] 每元素上溯步数 期望 ${plan.expect.ancestorStepsPerTarget} 实测 ${observed.ancestorStepsPerTarget}`,
    );
  }
  return out;
}
