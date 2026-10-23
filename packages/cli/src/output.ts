import { splitDiagnosis } from "@vortex-browser/shared";
import type { ClickEffectLike, SequenceReport, StepTrace } from "@vortex-browser/shared";

export interface OutputOptions {
  pretty?: boolean;
  quiet?: boolean;
}

/**
 * 输出响应。
 * --quiet: 只输出 result
 * --pretty: 格式化 JSON
 * 默认: 一行 NDJSON
 */
export function printResponse(data: unknown, opts: OutputOptions): void {
  // 空结果自陈拆到 stderr:stdout 要能直接喂 jq,混进信封会让下游拿到对象而非数组。
  let payload = data;
  if (typeof data === "object" && data !== null && "result" in (data as object)) {
    const { value, diagnosis } = splitDiagnosis((data as any).result);
    if (diagnosis) {
      console.error(`[vortex-diagnosis] ${diagnosis}`);
      payload = { ...(data as object), result: value };
    }
  }

  const output = opts.quiet && typeof payload === "object" && payload !== null
    ? (payload as any).result ?? (payload as any).error ?? payload
    : payload;

  if (opts.pretty) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(JSON.stringify(output));
  }
}

/**
 * 输出事件（subscribe --follow 模式）。
 */
export function printEvent(data: unknown, opts: OutputOptions): void {
  if (opts.pretty) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data));
  }
}

/**
 * 输出错误并退出。
 */
export function exitWithError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** 从响应信封里取 result，并把空结果自陈拆到 stderr（与 printResponse 同款取舍）。 */
function resultOf(data: unknown): unknown {
  if (typeof data !== "object" || data === null || !("result" in (data as object))) return undefined;
  const { value, diagnosis } = splitDiagnosis((data as any).result);
  if (diagnosis) console.error(`[vortex-diagnosis] ${diagnosis}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * act 的可读输出。
 *
 * 「点了没有」不能只看 success：扩展在 observeEffect 开启时会回传副作用信号
 * （DOM 变更 / 网络请求 / URL 变化 / 焦点变化 / ARIA 变化 / 用户反馈），
 * 这里逐项列出来，silent failure 才有判据。
 */
export function formatActReadable(action: string, target: string, result: unknown): string {
  const r = asRecord(result);
  const lines: string[] = [];
  const status = r.success === true ? "success" : r.error ? `error: ${String(r.error)}` : "ok";
  lines.push(`${action} ${target} → ${status}`);

  const effect = r.effect as ClickEffectLike | undefined;
  if (effect && typeof effect === "object") {
    lines.push(
      `effect: domMutations=${effect.domMutations} networkRequests=${effect.networkRequests}` +
        ` urlChanged=${effect.urlChanged} focusChanged=${effect.focusChanged}` +
        ` ariaChanged=${effect.ariaChanged} userFeedback=${effect.userFeedback}`,
    );
  }
  if (typeof r.value === "string") lines.push(`value: ${JSON.stringify(r.value)}`);
  if (typeof r.moved === "boolean") lines.push(`moved: ${r.moved}`);
  const dialogs = Array.isArray(r.dialogs) ? (r.dialogs as Array<{ type?: string }>) : [];
  if (dialogs.length > 0) {
    lines.push(`dialogs: ${dialogs.map((d) => d?.type ?? "?").join(", ")}`);
  }
  const element = asRecord(r.element);
  if (element.tag) {
    const id = element.id ? `#${element.id}` : "";
    lines.push(`element: ${element.tag}${id}`);
  }
  return lines.join("\n");
}

/** observe 的可读输出。 */
export function formatObserveReadable(result: unknown): string {
  const r = asRecord(result);
  const elements = Array.isArray(r.elements) ? (r.elements as Array<Record<string, unknown>>) : [];
  const lines: string[] = [];
  const title = r.title ? ` · ${String(r.title)}` : "";
  lines.push(`snapshot ${String(r.snapshotId ?? "?")} · ${String(r.url ?? "?")}${title}`);
  lines.push(`${elements.length} elements`);
  for (const el of elements) {
    const ref = typeof el.ref === "string" ? el.ref : "";
    const role = typeof el.role === "string" ? el.role : "";
    const name = typeof el.name === "string" ? el.name : "";
    if (!ref && !role && !name) continue;
    lines.push(`  ${ref.padEnd(10)} ${role.padEnd(10)} ${name}`.trimEnd());
  }
  return lines.join("\n");
}

/** 序列里每一步的可读行。 */
function formatStepLine(step: StepTrace): string {
  const head = `${String(step.index + 1).padStart(2)}. ${step.action.padEnd(6)} ${step.target}`;
  const state = step.state;
  const bits: string[] = [state];
  if (step.effect) bits.push(`effect: ${step.effect}`);
  // 无自证通道的动作（如 hover）：压根没参与判定，不是「判定失败」
  if (step.verification === "not_applicable") bits.push("verification: not_applicable");
  if (step.error) bits.push(`error: ${step.error}`);
  if (step.diagnosis) bits.push(`diagnosis: ${step.diagnosis}`);
  return `${head} → ${bits.join(" | ")}`;
}

/** sequence 的可读输出。 */
export function formatSequenceReadable(report: SequenceReport): string {
  const lines: string[] = [];
  lines.push(`sequence ${report.steps.length} steps`);
  for (const step of report.steps) lines.push(formatStepLine(step));
  const s = report.summary;
  lines.push(
    `summary: total=${s.total} verified=${s.verified} unverified=${s.unverified}` +
      ` failed=${s.failed} not_executed=${s.notExecuted}`,
  );
  return lines.join("\n");
}

/** act 的可读输出（把诊断自陈拆到 stderr，stdout 只留人看的几行）。 */
export function printActResult(action: string, target: string, resp: unknown, _opts: OutputOptions): void {
  console.log(formatActReadable(action, target, resultOf(resp)));
}

/** observe 的可读输出。 */
export function printObserveResult(resp: unknown, _opts: OutputOptions): void {
  console.log(formatObserveReadable(resultOf(resp)));
}

/** sequence 的可读输出。 */
export function printSequenceResult(report: SequenceReport, _opts: OutputOptions): void {
  console.log(formatSequenceReadable(report));
}
