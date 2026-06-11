/**
 * Author: qingwa
 * Description: spike(cdp-first 阶段1) — cdpClickElement 返回 timings 延迟拆分。
 *
 * spike 决策矩阵需要「CDP click 慢在哪」的拆分数据:attach(冷/热)、page-side
 * 探测、Input dispatch 三段。本测试行为级验证 timings 字段存在且数值合理
 * (mock 各依赖可控延迟,断言对应段 ≥ 注入延迟)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pageQueryMock = vi.fn();
vi.mock("../src/adapter/native.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pageQuery: (...args: unknown[]) => pageQueryMock(...args),
  };
});

vi.mock("../src/lib/iframe-offset.js", () => ({
  getIframeOffset: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
}));

import { cdpClickElement } from "../src/adapter/cdp.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("spike(cdp-first): cdpClickElement timings 拆分", () => {
  let debuggerMgr: { attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    pageQueryMock.mockResolvedValue({
      result: { x: 50, y: 60, tag: "button", text: "OK" },
    });
    debuggerMgr = {
      attach: vi.fn(async () => {
        await sleep(20);
      }),
      sendCommand: vi.fn(async () => {
        await sleep(5);
      }),
    };
  });

  it("结果带 timings{attachMs,probeMs,dispatchMs} 且 attachMs 反映 attach 真实耗时", async () => {
    const res = await cdpClickElement(debuggerMgr as never, 1, undefined, "#btn");
    const timings = (res as { timings?: { attachMs: number; probeMs: number; dispatchMs: number } })
      .timings;
    expect(timings).toBeDefined();
    expect(timings!.attachMs).toBeGreaterThanOrEqual(15); // attach mock 睡 20ms
    expect(timings!.probeMs).toBeGreaterThanOrEqual(0);
    expect(timings!.dispatchMs).toBeGreaterThanOrEqual(10); // 3 次 dispatch × 5ms
  });

  it("原有结果字段不受影响(success/element/x/y/mode)", async () => {
    const res = await cdpClickElement(debuggerMgr as never, 1, undefined, "#btn");
    expect(res).toMatchObject({
      success: true,
      element: { tag: "button" },
      x: 50,
      y: 60,
      mode: "realMouse",
    });
  });
});
