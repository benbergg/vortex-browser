// 可验证确定性重放——效果指纹(EffectFingerprint)。
// 竞品分析提案 A:把 act 效果固化成可序列化、抗波动的指纹,供重放校验。
// 类别签名(波动量→布尔)+ 确定量精确,见 spec §2。

/** click 归一化只读 ClickEffect 的这些字段(结构子集,避免 shared→extension 反向依赖)。 */
export interface ClickEffectLike {
  domMutations: number;
  networkRequests: number;
  urlChanged: boolean;
  focusChanged: boolean;
  ariaChanged: boolean;
  userFeedback: "dialog" | "toast" | "mutation" | "none";
}

export interface EffectFingerprint {
  action: "click" | "fill" | "type" | "select" | "scroll";
  /** role::name::frameId(语义身份,NOT ref——ref 跨快照必变)。 */
  targetIdentity: string;
  // —— 确定量(精确 / 容差比对)——
  urlChanged: boolean;
  valueAfter?: string;
  scrollAfter?: { top: number; left: number };
  // —— 类别签名(波动量 → 布尔,click 来自 ClickEffect 副作用)——
  causedDomMutation?: boolean;
  causedNetwork?: boolean;
  focusChanged?: boolean;
  ariaChanged?: boolean;
  userFeedback?: "dialog" | "toast" | "mutation" | "none";
  /** 弱效果动作(hover/drag):无确定量,verify 只比类别。 */
  weak?: true;
}

/** click 没有回读值,只能靠副作用判生效 → 类别签名 + url + targetIdentity。 */
export function normalizeClickFingerprint(
  targetIdentity: string,
  effect: ClickEffectLike,
): EffectFingerprint {
  return {
    action: "click",
    targetIdentity,
    urlChanged: effect.urlChanged,
    causedDomMutation: effect.domMutations > 0,
    causedNetwork: effect.networkRequests > 0,
    focusChanged: effect.focusChanged,
    ariaChanged: effect.ariaChanged,
    userFeedback: effect.userFeedback,
  };
}
