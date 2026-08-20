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
  // shadow 两条压不同的东西:广度压 queryAllDeep(每个 shadow root 都要 querySelectorAll("*")
  // 找 host),深度压 deepElementFromPoint(每层多一次命中测试)。
  { id: "shadow-breadth", nodes: 4000, depth: 10, targets: 50, painted: true, shadow: { hosts: 200, nest: 1 } },
  // 不上色:让上溯真的走完整条 composed 链(穿 6 层 shadow + 主链 + body/html),
  // painted 的话 card 第一步就 break,压不到跨 shadow 那段
  { id: "shadow-nested", nodes: 2000, depth: 10, targets: 50, painted: false, shadow: { hosts: 20, nest: 6 } },
];

/**
 * 算这份语料生成后的真实节点数。
 * 主链 depth 个 div + 若干 card,card 数按补足 nodes 取整,至少放得下 targets。
 */
/** 装 card 的容器数:shadow 形状是每条嵌套链最内层的 shadow root,否则只有主链末端一个 */
function hostsOf(shape: CorpusShape): number {
  return shape.shadow ? shape.shadow.hosts : 0;
}

function planCounts(shape: CorpusShape): { cards: number; domNodes: number; shadowRoots: number } {
  const chainNodes = shape.depth + (shape.shadow ? shape.shadow.hosts * shape.shadow.nest : 0);
  const needForTargets = Math.ceil(shape.targets / TARGETS_PER_CARD);
  const needForNodes = Math.ceil(Math.max(0, shape.nodes - chainNodes) / NODES_PER_CARD);
  const cards = Math.max(needForTargets, needForNodes);
  // 只数自己造的子树:落脚页 head 里有多少 meta/script 不该进真值。
  // shadow 里的节点 document.querySelectorAll("*") 看不见,所以观测侧必须用深走查。
  return { cards, domNodes: chainNodes + cards * NODES_PER_CARD, shadowRoots: shape.shadow ? shape.shadow.hosts * shape.shadow.nest : 0 };
}

/**
 * contrast 每个目标元素要走的祖先步数。
 * painted 时最近祖先(card)就有底色,第一步即 break;否则一路走到 html 都找不到绘制背景,
 * 步数 = card + 主链 depth + body + html。
 */
function ancestorSteps(shape: CorpusShape): number {
  // card 有底色就第一步 break。否则走完整条 composed 链:
  // card(1) + nest 个 host + depth 条主链 + body + html。
  // 走 composed 而不是 parentElement —— 后者在 shadow 边界断,够不到 host 的背景。
  if (shape.painted) return 1;
  return 1 + (shape.shadow ? shape.shadow.nest : 0) + shape.depth + 2;
}

/** 形状 → 可在页内直接 eval 的建树脚本 + 结构真值 */
export function buildCorpus(shape: CorpusShape): CorpusPlan {
  if (shape.depth < 1) throw new Error(`depth 必须 >= 1: ${shape.id}`);
  if (shape.targets < 1) throw new Error(`targets 必须 >= 1: ${shape.id}`);
  if (shape.shadow && (shape.shadow.hosts < 1 || shape.shadow.nest < 1)) {
    throw new Error(`shadow.hosts / shadow.nest 必须 >= 1: ${shape.id}`);
  }
  const { cards, domNodes, shadowRoots } = planCounts(shape);
  const slotsUsed = Math.min(cards, hostsOf(shape) || 1);
  const cardBg = shape.painted ? '"#ffffff"' : '""';
  const hosts = shape.shadow ? shape.shadow.hosts : 0;
  const nest = shape.shadow ? shape.shadow.nest : 0;

  const buildScript = `(function(){
  // 钉死 html/body 透明:否则上溯步数真值取决于落脚页有没有设背景,换页就崩
  document.documentElement.style.backgroundColor = "transparent";
  document.body.style.backgroundColor = "transparent";
  document.body.innerHTML = "";
  var root = document.createElement("div"), cur = root;
  for (var i = 1; i < ${shape.depth}; i++) { var d = document.createElement("div"); cur.appendChild(d); cur = d; }

  // card 挂到哪些容器里:纯 light DOM 就是主链末端,shadow 形状则是每条嵌套链最内层的 shadow root
  var slots = [];
  if (${hosts} > 0) {
    for (var h = 0; h < ${hosts}; h++) {
      var sr = null;
      for (var n = 0; n < ${nest}; n++) {
        var host = document.createElement("div");
        host.className = "host";
        (sr || cur).appendChild(host);
        sr = host.attachShadow({ mode: "open" });
      }
      slots.push(sr);
    }
  } else { slots.push(cur); }

  for (var c = 0; c < ${cards}; c++) {
    var card = document.createElement("div");
    card.className = "card";
    if (${cardBg}) card.style.backgroundColor = ${cardBg};
    card.innerHTML = '<span class="t">label</span><a class="t" href="/x">link</a><input class="t" value="v">';
    slots[c % slots.length].appendChild(card);
  }
  document.body.appendChild(root);
  document.body.getBoundingClientRect();

  // shadow 里的节点 document.querySelectorAll("*") 看不见,必须深走查才对得上真值
  function deepCount(r, d) {
    var all = r.querySelectorAll("*"), n = all.length, roots = 0, maxNest = 0;
    for (var i = 0; i < all.length; i++) {
      var s = all[i].shadowRoot;
      if (s && d < 20) {
        roots++;
        var sub = deepCount(s, d + 1);
        n += sub.n; roots += sub.roots;
        if (sub.maxNest + 1 > maxNest) maxNest = sub.maxNest + 1;
      }
    }
    return { n: n, roots: roots, maxNest: maxNest };
  }
  function deepAll(sel, r, d, acc) {
    Array.prototype.push.apply(acc, r.querySelectorAll(sel));
    var all = r.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) { var s = all[i].shadowRoot; if (s && d < 20) deepAll(sel, s, d + 1, acc); }
    return acc;
  }
  // 上溯步数也在这里量:jsdom 里就能离线核,不必等真机
  function composedParent(n) {
    var p = n.parentNode;
    if (p && p.nodeType === 1) return p;
    if (p && p.nodeType === 11) return p.host || null;
    return null;
  }
  function stepsFor(el) {
    var k = 0;
    for (var a = composedParent(el); a; a = composedParent(a)) {
      k++;
      var cs = getComputedStyle(a);
      if (cs.backgroundImage !== "none") break;
      if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") break;
    }
    return k;
  }
  var dc = deepCount(root, 0);
  var firstTarget = deepAll(".t", root, 0, [])[0];
  return { domNodes: dc.n + 1, shadowRoots: dc.roots, maxNest: dc.maxNest,
           slotsUsed: slots.filter(function(sl){ return !!sl.querySelector(".card"); }).length,
           ancestorStepsPerTarget: firstTarget ? stepsFor(firstTarget) : 0,
           targets: deepAll(".t", root, 0, []).length };
})()`;

  return {
    shape,
    buildScript,
    expect: { domNodes, ancestorStepsPerTarget: ancestorSteps(shape), shadowRoots, maxNest: nest, slotsUsed },
  };
}

/** 结构真值比对。返回空数组表示语料如预期生成 —— 这是压测里唯一可阻断的判据。 */
export function checkStructure(
  plan: CorpusPlan,
  observed: {
    domNodes: number; ancestorStepsPerTarget: number; shadowRoots: number;
    maxNest: number; slotsUsed: number;
  },
): string[] {
  const out: string[] = [];
  const cmp = (label: string, exp: number, got: number): void => {
    if (exp !== got) out.push(`[${plan.shape.id}] ${label} 期望 ${exp} 实测 ${got}`);
  };
  cmp("节点数", plan.expect.domNodes, observed.domNodes);
  cmp("每元素上溯步数", plan.expect.ancestorStepsPerTarget, observed.ancestorStepsPerTarget);
  cmp("shadow root 数", plan.expect.shadowRoots, observed.shadowRoots);
  cmp("shadow 嵌套层数", plan.expect.maxNest, observed.maxNest);
  cmp("装了 card 的容器数", plan.expect.slotsUsed, observed.slotsUsed);
  return out;
}
