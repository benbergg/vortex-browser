// packages/vortex-bench/src/runner/fuzz-generate.ts
// 文法:seed → FuzzPage。随机噪声树 + 随机位置种入若干可交互原语。
// 决定论:全程用 makePrng(seed),无 Math.random。

import { makePrng } from "./fuzz-prng.js";
import type { AstNode, FuzzPage, NoiseNode, PrimitiveKind, PrimitiveNode } from "../fuzz-types.js";
import { FUZZ_RECALL_CONTAINERS, FUZZ_DECORATIVE_ROLES } from "./fuzz-aria-roles.js";

export const ALL_PRIMITIVE_KINDS: PrimitiveKind[] = [
  "native-button", "anchor", "role-button-div", "cursor-pointer-div",
  "icon-svg-title", "icon-img-alt", "icon-aria-label", "shadow-button", "srcdoc-button",
  // Task 7:ARIA 容器 / 装饰角色节点,oracle 双断言(Recall=true / false)
  "aria-container", "decorative-role",
];

const NAME_POOL = ["保存", "打开菜单", "关闭", "搜索", "提交", "取消", "下一步", "返回", "编辑", "删除"];
// aria-hidden 元素仍可渲染/点击,不是可证明非交互的隐藏方式,故从生成器中排除
const HIDDEN_MODES = ["display-none", "visibility-hidden"] as const;

export function generate(seed: number): FuzzPage {
  const r = makePrng(seed);
  let idCounter = 0;
  const nextId = (): string => `p${idCounter++}`;

  // Task 7:种入 ARIA 容器 / 装饰角色节点(盲点守卫)。
  // 容器(aria-container)挑 RECALL_ROLES 容器类 — oracle 期望 observe 召回(Recall=true)。
  // 装饰(decorative-role)挑 EXPLICIT_DENY 装饰占位(presentation/none/generic)—
  // oracle 期望 observe 不召回(Recall=false)。两类节点用同等 PRNG 步进,保持决定论。
  //
  // 数量控制:容器 0..2、装饰 0..1,追加在 1..8 既有路径之后;
  // 这样既有 fuzz-generate / fuzz-ast / fuzz-shrink 测试不受 PRNG 序列变化影响。
  // 容器不放在 hidden 祖先里(否则 deriveManifest interactive:false 误判),
  // 但 generate 不传 allowHidden 信息,所以容器节点在 placePrimitive 阶段自然走默认;
  // 这里我们对 decorative-role 用同样默认路径(placePrimitive 接受原 kind 决定 allowHidden)。
  const recallContainersArr = Array.from(FUZZ_RECALL_CONTAINERS);
  const decorativeRolesArr = Array.from(FUZZ_DECORATIVE_ROLES);

  const nPrimitives = 1 + r.int(8); // 1..8
  const primitives: PrimitiveNode[] = [];
  for (let i = 0; i < nPrimitives; i++) {
    const kind = r.pick(ALL_PRIMITIVE_KINDS);
    // 1..8 路径也可能命中 aria-container / decorative-role(Task 7 之后 ALL_PRIMITIVE_KINDS
    // 含二者),需要按 kind 填充 role,否则后续 fuzz-ast.test / render 断言会失败。
    const node: PrimitiveNode = {
      type: "primitive", kind, id: nextId(), name: r.pick(NAME_POOL),
    };
    if (kind === "aria-container") {
      node.role = r.pick(recallContainersArr);
    } else if (kind === "decorative-role") {
      node.role = r.pick(decorativeRolesArr);
    }
    primitives.push(node);
  }

  // Task 7:种入 ARIA 容器 / 装饰角色节点(盲点守卫)。
  // 容器(aria-container)挑 RECALL_ROLES 容器类 — oracle 期望 observe 召回(Recall=true)。
  // 装饰(decorative-role)挑 EXPLICIT_DENY 装饰占位(presentation/none/generic)—
  // oracle 期望 observe 不召回(Recall=false)。两类节点用同等 PRNG 步进,保持决定论。
  //
  // 数量控制:容器 0..2、装饰 0..1,追加在 1..8 既有路径之后;
  // recallContainersArr / decorativeRolesArr 已在函数顶部声明(被 1..8 路径共享)。
  const nContainers = r.int(3); // 0..2
  for (let i = 0; i < nContainers; i++) {
    primitives.push({
      type: "primitive",
      kind: "aria-container",
      id: nextId(),
      name: r.pick(NAME_POOL),
      role: r.pick(recallContainersArr),
    });
  }
  const nDecorative = r.int(2); // 0..1
  for (let i = 0; i < nDecorative; i++) {
    primitives.push({
      type: "primitive",
      kind: "decorative-role",
      id: nextId(),
      name: r.pick(NAME_POOL),
      role: r.pick(decorativeRolesArr),
    });
  }

  // srcdoc-button 用 joinBy:"name" 匹配,同一页任何原语与 srcdoc-button 重名都会导致
  // name-join 被主 frame 元素静默命中,造成召回失败被吞掉。
  // 后处理:确保同一页内所有 srcdoc-button 的名称全局唯一(不与任何其他原语重名)。
  // 非 srcdoc 原语之间可以重名(几何 join,无害)。
  {
    // 收集所有非 srcdoc 原语已占用的名称(全页保留集)
    const reservedNames = new Set<string>(
      primitives.filter((p) => p.kind !== "srcdoc-button").map((p) => p.name),
    );
    const usedSrcdocNames = new Set<string>();
    // 构建扩展名池:原池 10 个,加数字后缀保底(原语最多 8 个,一般不会耗尽)
    const extendedPool = [...NAME_POOL];
    for (let i = 0; extendedPool.length < primitives.length + NAME_POOL.length; i++) {
      extendedPool.push(`${NAME_POOL[i % NAME_POOL.length]}-${i}`);
    }
    for (const prim of primitives) {
      if (prim.kind !== "srcdoc-button") continue;
      // 名称必须不在已占用 srcdoc 集合里,也不在非 srcdoc 原语名集合里
      if (!usedSrcdocNames.has(prim.name) && !reservedNames.has(prim.name)) {
        usedSrcdocNames.add(prim.name);
        continue;
      }
      // 名称碰撞:从扩展名池里选一个既未被 srcdoc 占用、也未被其他原语保留的候选
      const candidates = extendedPool.filter((n) => !usedSrcdocNames.has(n) && !reservedNames.has(n));
      prim.name = candidates.length > 0 ? r.pick(candidates) : `${prim.name}-${usedSrcdocNames.size}`;
      usedSrcdocNames.add(prim.name);
    }
  }

  // 噪声叶子/容器构造:深度受限,避免爆炸
  let classCounter = 0;
  const nextClass = (): string => `nx${classCounter++}`;
  // allowHidden:false 时仍做相同的 PRNG 采样,但不赋值 hidden,
  // 保证非 srcdoc 路径字节一致(PRNG 序列不变)。
  const makeNoise = (depth: number, children: AstNode[], allowHidden = true): NoiseNode => {
    const node: NoiseNode = {
      type: "noise",
      tag: r.bool(0.8) ? "div" : "span",
      className: nextClass(),
      children,
    };
    // 15% 概率给可见噪声子树套隐藏(让其下原语成为 interactive:false 用例)
    if (depth > 0 && r.bool(0.15)) {
      if (allowHidden) node.hidden = r.pick(HIDDEN_MODES);
      else r.pick(HIDDEN_MODES); // 保持 PRNG 步进一致,丢弃结果
    }
    return node;
  };

  // 把 primitives 散布到随机深度的噪声树里
  // srcdoc-button 不允许被放进隐藏包装(display:none 会导致 iframe 不渲染)。
  const placePrimitive = (p: PrimitiveNode, maxDepth: number): AstNode => {
    const allowHidden = p.kind !== "srcdoc-button";
    let node: AstNode = p;
    const wraps = r.int(maxDepth + 1); // 0..maxDepth 层包装
    for (let d = 0; d < wraps; d++) node = makeNoise(d + 1, [node], allowHidden);
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
