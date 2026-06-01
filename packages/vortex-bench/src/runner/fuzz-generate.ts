// packages/vortex-bench/src/runner/fuzz-generate.ts
// 文法:seed → FuzzPage。随机噪声树 + 随机位置种入若干可交互原语。
// 决定论:全程用 makePrng(seed),无 Math.random。

import { makePrng } from "./fuzz-prng.js";
import type { AstNode, FuzzPage, NoiseNode, PrimitiveKind, PrimitiveNode } from "../fuzz-types.js";

export const ALL_PRIMITIVE_KINDS: PrimitiveKind[] = [
  "native-button", "anchor", "role-button-div", "cursor-pointer-div",
  "icon-svg-title", "icon-img-alt", "icon-aria-label", "shadow-button", "srcdoc-button",
];

const NAME_POOL = ["保存", "打开菜单", "关闭", "搜索", "提交", "取消", "下一步", "返回", "编辑", "删除"];
// aria-hidden 元素仍可渲染/点击,不是可证明非交互的隐藏方式,故从生成器中排除
const HIDDEN_MODES = ["display-none", "visibility-hidden"] as const;

export function generate(seed: number): FuzzPage {
  const r = makePrng(seed);
  let idCounter = 0;
  const nextId = (): string => `p${idCounter++}`;

  const nPrimitives = 1 + r.int(8); // 1..8
  const primitives: PrimitiveNode[] = [];
  for (let i = 0; i < nPrimitives; i++) {
    const kind = r.pick(ALL_PRIMITIVE_KINDS);
    primitives.push({ type: "primitive", kind, id: nextId(), name: r.pick(NAME_POOL) });
  }

  // 噪声叶子/容器构造:深度受限,避免爆炸
  let classCounter = 0;
  const nextClass = (): string => `nx${classCounter++}`;
  const makeNoise = (depth: number, children: AstNode[]): NoiseNode => {
    const node: NoiseNode = {
      type: "noise",
      tag: r.bool(0.8) ? "div" : "span",
      className: nextClass(),
      children,
    };
    // 15% 概率给可见噪声子树套隐藏(让其下原语成为 interactive:false 用例)
    if (depth > 0 && r.bool(0.15)) node.hidden = r.pick(HIDDEN_MODES);
    return node;
  };

  // 把 primitives 散布到随机深度的噪声树里
  const placePrimitive = (p: PrimitiveNode, maxDepth: number): AstNode => {
    let node: AstNode = p;
    const wraps = r.int(maxDepth + 1); // 0..maxDepth 层包装
    for (let d = 0; d < wraps; d++) node = makeNoise(d + 1, [node]);
    return node;
  };

  const placed = r.shuffle(primitives).map((p) => placePrimitive(p, 3));
  // 再插入若干纯噪声兄弟(无原语),增加干扰
  const pureNoiseCount = r.int(4);
  for (let i = 0; i < pureNoiseCount; i++) {
    placed.push(makeNoise(1, [makeNoise(2, [])]));
  }

  const root: NoiseNode = {
    type: "noise", tag: "div", className: "fuzz-root",
    children: r.shuffle(placed),
  };
  return { seed, root };
}
