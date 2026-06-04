// MCP 传输超时计算。族 D 原则:当调用方 timeout 被透传作 handler 内层 poll 预算时,
// 外层传输超时必须 > 内层,留 buffer——否则二者在同一 deadline 竞race,传输层(client.ts
// requestOnce)先 fire → 调用方见 "no response for <action> after Nms" 丑错,而非
// handler 干净的 condition-not-met(TIMEOUT,带条件文案)。WAIT-TIMEOUT-MARGIN(2026-06-04 审计)。

// 传输超时相对内层预算的 margin。覆盖 NM↔扩展 WS 回程 + handler teardown。
// 与扩展端 NAVIGATE_LOAD_TIMEOUT_MS 留给传输的 5s margin 同源。
export const TRANSPORT_TIMEOUT_BUFFER_MS = 5_000;

/**
 * 由调用方 timeout 计算外层传输超时。
 * - 未指定:用默认传输超时(各 handler 自身 default 内层 cap 均 < 此值,margin 由设计保证)。
 * - 指定:调用方 timeout 作内层预算透传给 handler,传输 = 内层 + buffer,确保 handler
 *   在传输放弃前先返回干净结果。caller=0 视为显式短预算,不回退默认。
 */
export function computeTransportTimeout(
  callerTimeout: number | undefined,
  defaultTimeout: number,
): number {
  if (callerTimeout == null) return defaultTimeout;
  return callerTimeout + TRANSPORT_TIMEOUT_BUFFER_MS;
}
