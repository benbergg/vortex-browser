import { describe, it, expect } from "vitest";
import {
  computeTransportTimeout,
  TRANSPORT_TIMEOUT_BUFFER_MS,
} from "../src/lib/timeout.js";

/**
 * 白盒审计批次 3 族 O — WAIT-TIMEOUT-MARGIN。
 *
 * 调用方 timeout 被透传作 handler 内层 poll 预算时,外层传输超时必须 > 内层,
 * 留 buffer。原 server.ts 把 effectiveTimeout = caller timeout 直接作传输超时,
 * 与被透传到 handler 的同一 timeout 在同一 deadline 竞race → 传输层先 fire,
 * 调用方见 "no response for page.wait after Nms" 丑错而非 handler 的干净
 * condition-not-met(TIMEOUT,带条件文案)。
 */
describe("computeTransportTimeout (WAIT-TIMEOUT-MARGIN)", () => {
  const DEFAULT = 30_000;

  it("未指定 timeout → 用默认传输超时", () => {
    expect(computeTransportTimeout(undefined, DEFAULT)).toBe(DEFAULT);
  });

  it("指定 timeout → 传输 = caller + buffer(严格大于 caller,留 margin)", () => {
    const caller = 1_500;
    const t = computeTransportTimeout(caller, DEFAULT);
    expect(t).toBe(caller + TRANSPORT_TIMEOUT_BUFFER_MS);
    expect(t).toBeGreaterThan(caller);
  });

  it("buffer 至少 3s(覆盖 NM 回程 + handler teardown)", () => {
    expect(TRANSPORT_TIMEOUT_BUFFER_MS).toBeGreaterThanOrEqual(3_000);
  });

  it("大 caller timeout 也线性留 buffer(传输随之放大,不被默认 30s 截断)", () => {
    const caller = 60_000;
    expect(computeTransportTimeout(caller, DEFAULT)).toBe(caller + TRANSPORT_TIMEOUT_BUFFER_MS);
  });

  it("caller=0 视为显式短预算,仍 = 0 + buffer(不回退默认)", () => {
    expect(computeTransportTimeout(0, DEFAULT)).toBe(TRANSPORT_TIMEOUT_BUFFER_MS);
  });
});
