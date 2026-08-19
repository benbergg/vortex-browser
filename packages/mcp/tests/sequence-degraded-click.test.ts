import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Author: qingwa
 * Description: vortex_sequence 里的 click 步遇到降级自陈时,自证信道不能被包裹层吞掉。
 *
 * CDP 被占时 dom.click 降级为合成路径,结果经 withDiagnosis 包成 {__vtxDiagnosis,value}。
 * sequence 的单步自证读 result.effect —— 不拆包就永远读到 undefined,每一步都退化成
 * unknown,而降级恰恰是最需要效果证据的时候(2026-08-18 使用日志)。
 */
vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: {
    drain: vi.fn(() => []),
    subscribe: vi.fn(() => "sub_test"),
    unsubscribe: vi.fn(() => true),
  },
}));

const EFFECT = {
  domMutations: 3,
  networkRequests: 0,
  urlChanged: false,
  focusChanged: false,
  ariaChanged: false,
  userFeedback: "none" as const,
};

async function runClickSequence(result: unknown) {
  const { sendRequest } = await import("../src/client.js");
  vi.mocked(sendRequest).mockResolvedValue({
    action: "dom.click",
    id: "mcp-1-1780000000000",
    result,
  } as never);
  const { handleCallTool } = await import("../src/server.js");
  const resp = await handleCallTool({
    params: {
      name: "vortex_sequence",
      arguments: { steps: [{ action: "click", target: "#go" }] },
    },
  });
  return JSON.parse((resp.content[0] as { text: string }).text) as {
    steps: Array<{ state: string; effect?: string; diagnosis?: string }>;
  };
}

async function rawClickSequence(result: unknown) {
  const { sendRequest } = await import("../src/client.js");
  vi.mocked(sendRequest).mockResolvedValue({
    action: "dom.click",
    id: "mcp-1-1780000000000",
    result,
  } as never);
  const { handleCallTool } = await import("../src/server.js");
  const resp = await handleCallTool({
    params: {
      name: "vortex_sequence",
      arguments: { steps: [{ action: "click", target: "#go" }] },
    },
  });
  return (resp.content[0] as { text: string }).text;
}

describe("sequence 单步自证遇上降级自陈", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
  });

  it("未包裹的 click 结果照旧按 effect 自证", async () => {
    const report = await runClickSequence({ success: true, effect: EFFECT });
    expect(report.steps[0].state).toBe("executed_verified");
    expect(report.steps[0].effect).toBe("confirmed");
  });

  it("包裹在自陈信封里的降级结果同样按 effect 自证,不退化成 unknown", async () => {
    const { DIAGNOSIS_KEY } = await import("@vortex-browser/shared");
    const report = await runClickSequence({
      [DIAGNOSIS_KEY]: "Degraded to a synthetic click: isTrusted=false.",
      value: { success: true, degraded: "cdp-busy-synthetic", effect: EFFECT },
    });
    expect(report.steps[0].state).toBe("executed_verified");
    expect(report.steps[0].effect).toBe("confirmed");
  });
});

describe("sequence 报告承载单步自陈", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
  });

  it("降级步的自陈出现在最终报告里,不只在单调 vortex_act 时可见", async () => {
    const { DIAGNOSIS_KEY } = await import("@vortex-browser/shared");
    const report = await runClickSequence({
      [DIAGNOSIS_KEY]: "Degraded to a synthetic click: this dispatch had isTrusted=false.",
      value: { success: true, degraded: "cdp-busy-synthetic", effect: EFFECT },
    });
    expect(report.steps[0].diagnosis).toBe(
      "Degraded to a synthetic click: this dispatch had isTrusted=false.",
    );
  });

  it("无自陈时报告形状逐字节不变:既不多 diagnosis 键,键序也不变", async () => {
    const text = await rawClickSequence({ success: true, effect: EFFECT });
    expect(text).not.toContain("diagnosis");
    const step = JSON.parse(text).steps[0] as Record<string, unknown>;
    expect(Object.keys(step)).toEqual(["index", "action", "target", "state", "effect"]);
  });
});
