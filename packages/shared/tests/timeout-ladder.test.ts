/**
 * Author: qingwa
 * Description: Verifies the inner/hub/transport timeout ladder stays strictly increasing.
 */
import { describe, it, expect } from "vitest";
import {
  clampHubTimeout,
  MAX_HUB_TIMEOUT_MS,
  TIMEOUT_LADDER_STEP_MS,
  timeoutLadder,
  transportTimeoutFor,
} from "../src/timeout.js";

/**
 * 一次调用在三层各有一个 deadline：extension handler 内层预算 < hub pending < 客户端传输。
 * 必须严格递增，否则外层先 fire，调用方拿到的是"没人应答"而不是 handler 说得清的原因。
 *
 * 历史缺陷：三层各写各的常量（hub 30s / extension [1,60000] / MCP caller+5s），且
 * VtxRequest 根本没有 timeout 字段——调用方设 45s 会被 hub 静默砍在 30s，live 复现的
 * 错误是 hub 的 "Request js.evaluateAsync timed out"。本文件是这三层的唯一真源。
 */
describe("timeoutLadder", () => {
  const DEFAULT_HUB = 30_000;

  it("调用方指定 timeout 时 inner < hub < transport 严格递增", () => {
    const l = timeoutLadder(45_000, DEFAULT_HUB);
    expect(l.inner).toBe(45_000);
    expect(l.hub).toBeGreaterThan(l.inner as number);
    expect(l.transport).toBeGreaterThan(l.hub);
  });

  it("调用方要的大 timeout 不被 hub 默认值截断", () => {
    const l = timeoutLadder(45_000, DEFAULT_HUB);
    expect(l.hub).toBeGreaterThanOrEqual(45_000);
    expect(l.hub).toBeGreaterThan(DEFAULT_HUB);
  });

  it("未指定 timeout 时无内层预算，hub 用默认值", () => {
    const l = timeoutLadder(undefined, DEFAULT_HUB);
    expect(l.inner).toBeUndefined();
    expect(l.hub).toBe(DEFAULT_HUB);
  });

  it("未指定 timeout 时 transport 仍严格大于 hub，两者不同 deadline 竞 race", () => {
    const l = timeoutLadder(undefined, DEFAULT_HUB);
    expect(l.transport).toBeGreaterThan(l.hub);
  });

  it("caller=0 视为显式短预算，不回退默认", () => {
    const l = timeoutLadder(0, DEFAULT_HUB);
    expect(l.inner).toBe(0);
    expect(l.hub).toBe(TIMEOUT_LADDER_STEP_MS);
  });

  it("transportTimeoutFor 与 ladder 用同一公式", () => {
    const l = timeoutLadder(1_500, DEFAULT_HUB);
    expect(transportTimeoutFor(l.hub)).toBe(l.transport);
  });

  it("每层 margin 至少 3s，覆盖 NM 回程与 handler teardown", () => {
    expect(TIMEOUT_LADDER_STEP_MS).toBeGreaterThanOrEqual(3_000);
  });
});

describe("clampHubTimeout", () => {
  it("缺省时回退到 hub 自身默认", () => {
    expect(clampHubTimeout(undefined, 30_000)).toBe(30_000);
  });

  it("合法值原样透传", () => {
    expect(clampHubTimeout(50_000, 30_000)).toBe(50_000);
  });

  it("超上限被钳，防客户端把 pending 钉死", () => {
    expect(clampHubTimeout(MAX_HUB_TIMEOUT_MS + 1, 30_000)).toBe(MAX_HUB_TIMEOUT_MS);
  });

  it("负数与非有限值回退到默认而非崩", () => {
    expect(clampHubTimeout(-1, 30_000)).toBe(30_000);
    expect(clampHubTimeout(Number.NaN, 30_000)).toBe(30_000);
    expect(clampHubTimeout(Number.POSITIVE_INFINITY, 30_000)).toBe(30_000);
  });

  it("0 视为非法，回退默认（hub 侧 0 会让 pending 立刻自杀）", () => {
    expect(clampHubTimeout(0, 30_000)).toBe(30_000);
  });
});
