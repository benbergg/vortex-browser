import { splitDiagnosis } from "@vortex-browser/shared";

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
