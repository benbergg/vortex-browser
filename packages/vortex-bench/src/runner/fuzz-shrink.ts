// packages/vortex-bench/src/runner/fuzz-shrink.ts
// delta-debugging:在 AST 上反复施加"保失败"归约,求局部最小复现。
// 谓词 stillFails 由调用方注入(真实场景=重跑 scan 仍出同类分歧)。

import type { AstNode, FuzzPage, NoiseNode } from "../fuzz-types.js";
import { collectPrimitives } from "./fuzz-ast.js";

type Predicate = (page: FuzzPage) => Promise<boolean>;

/** 生成"候选归约":每个候选是去掉/简化一处的新页 */
function reductions(page: FuzzPage): FuzzPage[] {
  const out: FuzzPage[] = [];
  const prims = collectPrimitives(page.root);

  // 候选 1:逐个删原语(连同其最近的包装一并删)
  for (const p of prims) {
    out.push({ seed: page.seed, root: removeById(page.root, p.id) });
  }
  // 候选 2:逐个扁平化噪声(把噪声节点替换为其 children),减一层嵌套
  forEachNoise(page.root, (n) => {
    if (n !== page.root) out.push({ seed: page.seed, root: flattenNoise(page.root, n) });
  });
  // 候选 3:删纯噪声子树(不含任何原语的噪声)
  forEachNoise(page.root, (n) => {
    if (n !== page.root && collectPrimitives(n).length === 0) {
      out.push({ seed: page.seed, root: removeNode(page.root, n) });
    }
  });
  return out;
}

/** delta-debugging 主循环:贪心采纳第一个仍失败的归约,直到不动点 */
export async function shrink(page: FuzzPage, stillFails: Predicate): Promise<FuzzPage> {
  let current = page;
  let changed = true;
  while (changed) {
    changed = false;
    for (const cand of reductions(current)) {
      if (await stillFails(cand)) {
        current = cand;
        changed = true;
        break; // 重新从新页生成候选
      }
    }
  }
  return current;
}

// ---- AST 编辑 helper(均返回新树,不改原树）----

function removeById(root: NoiseNode, id: string): NoiseNode {
  const filterKids = (nodes: AstNode[]): AstNode[] =>
    nodes
      .filter((n) => !(n.type === "primitive" && n.id === id))
      .map((n) => (n.type === "noise" ? { ...n, children: filterKids(n.children) } : n))
      .filter((n) => !(n.type === "noise" && n.children.length === 0));
  return { ...root, children: filterKids(root.children) };
}

function removeNode(root: NoiseNode, target: NoiseNode): NoiseNode {
  const filterKids = (nodes: AstNode[]): AstNode[] =>
    nodes
      .filter((n) => n !== target)
      .map((n) => (n.type === "noise" ? { ...n, children: filterKids(n.children) } : n));
  return { ...root, children: filterKids(root.children) };
}

function flattenNoise(root: NoiseNode, target: NoiseNode): NoiseNode {
  const mapKids = (nodes: AstNode[]): AstNode[] => {
    const res: AstNode[] = [];
    for (const n of nodes) {
      if (n === target && n.type === "noise") {
        res.push(...n.children);
      } else if (n.type === "noise") {
        res.push({ ...n, children: mapKids(n.children) });
      } else {
        res.push(n);
      }
    }
    return res;
  };
  return { ...root, children: mapKids(root.children) };
}

function forEachNoise(node: NoiseNode, fn: (n: NoiseNode) => void): void {
  fn(node);
  for (const c of node.children) if (c.type === "noise") forEachNoise(c, fn);
}
