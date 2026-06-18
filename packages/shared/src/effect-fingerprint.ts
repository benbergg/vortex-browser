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

export type DriftClass =
  | "target" | "url" | "value" | "scroll"
  | "dom" | "network" | "focus" | "aria" | "feedback";

export interface Drift {
  classes: DriftClass[];
  details: Array<{ field: string; expected: unknown; actual: unknown }>;
}

const SCROLL_TOL = 5;

/** 比对两个指纹。返回 null=matched;否则列出 drift 类别 + 字段(诚实表征:说清哪里变了)。 */
export function compareFingerprint(
  expect: EffectFingerprint,
  actual: EffectFingerprint,
): Drift | null {
  const classes = new Set<DriftClass>();
  const details: Drift["details"] = [];
  const ne = (field: string, cls: DriftClass, e: unknown, a: unknown): void => {
    if (e !== a) { classes.add(cls); details.push({ field, expected: e, actual: a }); }
  };

  // 确定量(始终比对)
  ne("targetIdentity", "target", expect.targetIdentity, actual.targetIdentity);
  ne("urlChanged", "url", expect.urlChanged, actual.urlChanged);
  if (expect.valueAfter !== undefined || actual.valueAfter !== undefined) {
    ne("valueAfter", "value", expect.valueAfter, actual.valueAfter);
  }
  if (expect.scrollAfter || actual.scrollAfter) {
    const e = expect.scrollAfter, a = actual.scrollAfter;
    const off = (k: "top" | "left"): boolean =>
      Math.abs((e?.[k] ?? 0) - (a?.[k] ?? 0)) > SCROLL_TOL;
    if (!e || !a || off("top") || off("left")) {
      classes.add("scroll");
      details.push({ field: "scrollAfter", expected: e, actual: a });
    }
  }

  // 类别签名(weak fp 跳过——hover/drag 无确定性副作用判定)
  if (!expect.weak) {
    if (expect.causedDomMutation !== undefined)
      ne("causedDomMutation", "dom", expect.causedDomMutation, actual.causedDomMutation);
    if (expect.causedNetwork !== undefined)
      ne("causedNetwork", "network", expect.causedNetwork, actual.causedNetwork);
    if (expect.focusChanged !== undefined)
      ne("focusChanged", "focus", expect.focusChanged, actual.focusChanged);
    if (expect.ariaChanged !== undefined)
      ne("ariaChanged", "aria", expect.ariaChanged, actual.ariaChanged);
    if (expect.userFeedback !== undefined)
      ne("userFeedback", "feedback", expect.userFeedback, actual.userFeedback);
  }

  return classes.size ? { classes: [...classes], details } : null;
}
