/**
 * Author: qingwa
 * Description: Single source of truth for the inner/hub/transport timeout ladder.
 */

// 一次调用在三层各有一个 deadline，必须严格递增：
//   extension handler 内层预算  <  hub pending  <  客户端传输
// 递增才能让"说得清原因"的那一层先应答；外层先 fire 只会得到"没人应答"。
//
// 历史上三层各写各的常量且互不知情（hub 30s / extension [1,60000] / MCP caller+5s），
// 而 VtxRequest 上根本没有 timeout 字段——调用方设 45s 会被 hub 静默砍在 30s。

/** 每层相对内层多出的 margin，覆盖 NM 回程与 handler teardown */
export const TIMEOUT_LADDER_STEP_MS = 5_000;

/** hub 单个 pending 的上限，防客户端传入超大值把 pending 钉死 */
export const MAX_HUB_TIMEOUT_MS = 300_000;

/** 调用方可指定的内层预算上限。extension 校验与公开 schema 的 maximum 共用此值 */
export const MAX_INNER_TIMEOUT_MS = 60_000;

export interface TimeoutLadder {
  /** 透传给 extension handler 的内层预算；调用方未指定时不下发，handler 用自身默认 */
  inner?: number;
  /** hub pending 的 deadline，随请求上线 */
  hub: number;
  /** 客户端等待响应的上限 */
  transport: number;
}

/** 由 hub deadline 推客户端传输超时。与 timeoutLadder 共用同一公式 */
export function transportTimeoutFor(hubTimeoutMs: number): number {
  return hubTimeoutMs + TIMEOUT_LADDER_STEP_MS;
}

/**
 * 由调用方 timeout 算出三层 deadline。
 * @param callerInner 调用方指定的内层预算；0 视为显式短预算，不回退默认
 * @param defaultHub 调用方未指定时 hub 用的默认 deadline
 */
export function timeoutLadder(
  callerInner: number | undefined,
  defaultHub: number,
): TimeoutLadder {
  if (callerInner == null) {
    return { hub: defaultHub, transport: transportTimeoutFor(defaultHub) };
  }
  const hub = callerInner + TIMEOUT_LADDER_STEP_MS;
  return { inner: callerInner, hub, transport: transportTimeoutFor(hub) };
}

/** 收到的 hub deadline 落到合法区间；非法值回退默认而非让 pending 立刻自杀或永不超时 */
export function clampHubTimeout(requested: number | undefined, fallback: number): number {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(requested, MAX_HUB_TIMEOUT_MS);
}
