// packages/vortex-bench/src/fuzz-types.ts
// fuzz 子系统类型:AST 节点 + finding + report。与 scan-types.ts 解耦。

/** 可交互原语种类(起步集 = 现有 9 fixture 已验证 observe 能处理的同类) */
export type PrimitiveKind =
  | "native-button"
  | "anchor"
  | "role-button-div"
  | "cursor-pointer-div"
  | "icon-svg-title"
  | "icon-img-alt"
  | "icon-aria-label"
  | "shadow-button"   // 声明式 open shadow(<template shadowrootmode=open>)
  | "srcdoc-button"   // <iframe srcdoc> 内 button(跨 frame,joinBy:name)
  // Task 7:ARIA 容器 / 装饰角色节点。
  // aria-container = 显式 role ∈ RECALL_ROLES 容器集,期望观察召回(Recall=true)。
  // decorative-role = 显式 role ∈ EXPLICIT_DENY 装饰占位(presentation/none/generic),
  //                   严禁带 cursor:pointer/onclick/tabindex(plan line 659 教训),
  //                   期望观察不召回(Recall=false)。
  | "aria-container"
  | "decorative-role";

/** 种下的可交互元素:带已知 ground-truth */
export interface PrimitiveNode {
  type: "primitive";
  kind: PrimitiveKind;
  /** data-vtx-oracle id,全页唯一 */
  id: string;
  /** 期望 accessibleName */
  name: string;
  /** aria-container 的具体 ARIA role(随机从 FUZZ_RECALL_CONTAINERS 选);
   * 其他原语无此字段。 */
  role?: string;
}

/** 可证非交互的噪声包装 */
export interface NoiseNode {
  type: "noise";
  tag: "div" | "span";
  /** 非语义 class,纯干扰 */
  className: string;
  /** 隐藏方式;undefined=可见 */
  hidden?: "display-none" | "visibility-hidden" | "aria-hidden";
  children: AstNode[];
}

export type AstNode = PrimitiveNode | NoiseNode;

/** 一页 = 一个根噪声容器(其 children 是噪声树 + 种入的原语) */
export interface FuzzPage {
  seed: number;
  root: NoiseNode;
}

/** fuzz 发现的一条分歧(结构性高置信 / name 低置信) */
export interface FuzzFinding {
  seed: number;
  /** structural=漏报/误报(可沉淀);name=命名不符(只报) */
  cls: "structural" | "name";
  kind: "recall-miss" | "precision-miss" | "name-mismatch";
  detail: string;
  oracleId?: string;
}

export interface FuzzReport {
  generatedAt: string;
  playgroundUrl: string;
  seedsRun: number;
  selfTestOk: boolean;
  /** 隔离的原语(自检门挂掉的) */
  quarantined: PrimitiveKind[];
  findings: FuzzFinding[];
  /** 沉淀的 fixture 文件名(去扩展) */
  promoted: string[];
}
