// packages/shared/src/diagnosis.ts
//
// 空结果自陈信道。
//
// 起因(2026-08-11 使用基线):query 29.2%、debug_read 48.5% 的调用「成功且空」。
// isError 视角完全看不见这一类,调用方拿到 `[]` 或 `total: 0` 之后无法区分
// 「确实没有」和「我根本没搜到那儿去」,于是反复微调无关参数重试
// (实测有把 contextChars 260→300 再试一次的 —— 那个参数不影响命中数)。
//
// 契约:自陈只在结果为空或降级时出现,且**不改变非空结果的形状**。
// withDiagnosis(v, null) 返回 v 本身(同一引用),所以正常路径零开销、零形状变更。

/** 包裹键。`__vtx` 前缀确保不与任何真实载荷字段撞名 */
export const DIAGNOSIS_KEY = "__vtxDiagnosis";

export interface DiagnosisEnvelope {
  [DIAGNOSIS_KEY]: string;
  value: unknown;
}

/**
 * 给结果附一行自陈。diagnosis 为空(null/undefined/空白)时原样返回入参。
 * @param value 原始结果载荷
 * @param diagnosis 空/降级的原因与下一步动作，一行
 */
export function withDiagnosis<T>(value: T, diagnosis?: string | null): T | DiagnosisEnvelope {
  if (typeof diagnosis !== "string" || !diagnosis.trim()) return value;
  return { [DIAGNOSIS_KEY]: diagnosis.trim(), value };
}

/**
 * 拆出自陈。未包裹的结果原样透传，diagnosis 为 null。
 * @returns value 恢复后的载荷；diagnosis 自陈文本或 null
 */
export function splitDiagnosis(result: unknown): { value: unknown; diagnosis: string | null } {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const diagnosis = (result as Record<string, unknown>)[DIAGNOSIS_KEY];
    if (typeof diagnosis === "string") {
      return { value: (result as DiagnosisEnvelope).value, diagnosis };
    }
  }
  return { value: result, diagnosis: null };
}
