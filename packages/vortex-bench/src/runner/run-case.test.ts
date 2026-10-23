// runCase 的防假绿闸门 + 三个新指标（assertionCount / hintPresentRate / refReuseRate）。
//
// 为什么 mock mcp-client：闸门与指标口径全在 runner 侧（ctx.assert 计数、trace 事件统计），
// 与真实 MCP stdio 进程无关。mock 掉 stdio 连接后单测是秒级的，不依赖 playground 常驻，
// 也不依赖 vortex-mcp 二进制存在。
//
// 开关约定（父会话裁决）：
// - 防假绿闸门**永远生效**，与开关无关；
// - 三个新指标是"契约指标"，默认**不写进报告**（保证单跑输出与 base 提交逐字节一致），
//   需要显式打开（CLI `--contract-metrics` / env `VORTEX_BENCH_CONTRACT_METRICS=1`）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CaseDefinition, CaseMetrics } from "../types.js";
import { runCase } from "./run-case.js";

type ToolCallReq = { name: string; arguments: Record<string, unknown> };

const { callToolMock } = vi.hoisted(() => ({ callToolMock: vi.fn() }));

vi.mock("./mcp-client.js", () => ({
  createMcpConnection: vi.fn(async () => ({
    client: { callTool: callToolMock },
    transport: {},
    tools: [],
  })),
  closeMcpConnection: vi.fn(async () => {}),
}));

const OPTS = {
  mcpBin: "/nonexistent/vortex-mcp",
  playgroundUrl: "http://127.0.0.1:5173",
};

/** 打开契约指标开关的选项。 */
const OPTS_METRICS = { ...OPTS, contractMetrics: true };

function textResult(text: string, isError = false): unknown {
  return { isError, content: [{ text }] };
}

/** 去掉唯一易变字段（durationMs 依赖真实耗时），其余部分用于逐字节比对。 */
function stableJson(m: CaseMetrics): string {
  const { durationMs: _ignored, ...rest } = m;
  return JSON.stringify(rest);
}

beforeEach(() => {
  callToolMock.mockReset();
  callToolMock.mockImplementation(async (_req: ToolCallReq) => textResult("ok"));
});

describe("runCase 防假绿闸门", () => {
  it("用例一条断言都没做 → passed=false / failureClass=assertion_failure", async () => {
    const def: CaseDefinition = {
      name: "gate-no-assertion",
      playgroundPath: "/#/noop",
      // 故意不做任何断言：老实现下这个 case 会 passed=true（假绿）
      async run() {},
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(false);
    expect(m.failureClass).toBe("assertion_failure");
    expect(m.failureReason).toContain("未产生任何断言");
  });

  it("用例做过断言 → 正常通过", async () => {
    const def: CaseDefinition = {
      name: "gate-one-assertion",
      playgroundPath: "/#/ok",
      async run(ctx) {
        ctx.assert(true, "成立");
        ctx.assert(true, "也成立");
      },
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(true);
    expect(m.failureClass).toBeUndefined();
  });

  it("断言失败 → 仍是 assertion_failure", async () => {
    const def: CaseDefinition = {
      name: "gate-failed-assertion",
      playgroundPath: "/#/bad",
      async run(ctx) {
        ctx.assert(false, "boom");
      },
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(false);
    expect(m.failureClass).toBe("assertion_failure");
    expect(m.failureReason).toBe("boom");
  });

  it("用例已经失败时，闸门不覆盖它自己的 failureClass", async () => {
    const def: CaseDefinition = {
      name: "gate-env-failure",
      playgroundPath: "/#/env",
      async run() {
        throw new Error("vortex-server unreachable at localhost:6800.");
      },
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(false);
    expect(m.failureClass).toBe("env_failure");
  });
});

describe("契约指标开关", () => {
  it("默认（不传开关）→ 三个新指标都不写进报告", async () => {
    const def: CaseDefinition = {
      name: "metrics-off",
      playgroundPath: "/#/off",
      async run(ctx) {
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS);

    expect("assertionCount" in m).toBe(false);
    expect("hintPresentRate" in m).toBe(false);
    expect("refReuseRate" in m).toBe(false);
  });

  it("开关关闭 → 报告 JSON 与 base 提交逐字节一致", async () => {
    // GOLDEN 由 base 提交（6a586a2）的实现实测抓取，非手写
    const GOLDEN =
      '{"case":"switch-off-shape","passed":true,"callCount":3,"fallbackToEvaluate":0,' +
      '"observeMissedPopperItems":0,"outputBytes":6,' +
      '"outputBytesByTool":{"vortex_navigate":4,"vortex_wait_for":2}}';

    const def: CaseDefinition = {
      name: "switch-off-shape",
      playgroundPath: "/#/shape",
      async run(ctx) {
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS);

    expect(stableJson(m)).toBe(GOLDEN);
  });

  it("开关打开 → 三个新指标都写进报告", async () => {
    const def: CaseDefinition = {
      name: "metrics-on",
      playgroundPath: "/#/on",
      async run(ctx) {
        await ctx.call("vortex_act", { target: "@e3", action: "click" });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.assertionCount).toBe(1);
    expect(m.refReuseRate).toBe(1);
    expect(m.hintPresentRate).toBeUndefined(); // 本次无错误 → 分母为 0 → 不写
  });

  it("闸门不受开关影响：开关关闭时零断言用例照样判失败", async () => {
    const def: CaseDefinition = {
      name: "gate-without-switch",
      playgroundPath: "/#/noop",
      async run() {},
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(false);
    expect(m.failureClass).toBe("assertion_failure");
  });

  it("开关打开时零断言用例：闸门判定 + assertionCount=0 一起可见", async () => {
    const def: CaseDefinition = {
      name: "gate-with-switch",
      playgroundPath: "/#/noop",
      async run() {},
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.passed).toBe(false);
    expect(m.failureClass).toBe("assertion_failure");
    expect(m.assertionCount).toBe(0);
  });
});

describe("hintPresentRate", () => {
  it("错误文本都带 hint → 1", async () => {
    // 只有 case 体内这一次调用是错误；runCase 的开场三连调用（navigate×2 + wait_for）
    // 返回正常文本，不进分母。
    callToolMock.mockImplementation(async (req: ToolCallReq) => {
      if (req.name === "vortex_act") {
        return textResult("Error [STALE_SNAPSHOT]: 快照过期\nHint: 重新调用 vortex_observe", true);
      }
      return textResult("ok");
    });

    const def: CaseDefinition = {
      name: "hint-rate-all",
      playgroundPath: "/#/hint",
      async run(ctx) {
        await ctx.call("vortex_act", { target: "@e3", action: "click" });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.hintPresentRate).toBe(1);
  });

  it("一半错误文本带 hint → 0.5", async () => {
    callToolMock.mockImplementation(async (req: ToolCallReq) => {
      if (req.name === "vortex_wait_for") {
        return textResult("Error [TIMEOUT]: 等不到\nHint: 放宽 timeout", true);
      }
      if (req.name === "vortex_act") {
        return textResult("Error [INVALID_PARAMS]: target 缺失", true);
      }
      return textResult("ok");
    });

    const def: CaseDefinition = {
      name: "hint-rate-half",
      playgroundPath: "/#/hint",
      async run(ctx) {
        await ctx.call("vortex_act", { target: "@e3", action: "click" });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.hintPresentRate).toBe(0.5);
  });

  it("本次运行没有错误文本 → 分母为 0，字段不写入（保持 report 形状稳定）", async () => {
    const def: CaseDefinition = {
      name: "hint-rate-none",
      playgroundPath: "/#/hint",
      async run(ctx) {
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.hintPresentRate).toBeUndefined();
    expect("hintPresentRate" in m).toBe(false);
  });

  it("空文本错误（isError=true 但无内容）不进分母", async () => {
    // MCP 有时会回 isError=true 但 content 为空；这种调用不是"有错误文本的调用"
    callToolMock.mockImplementation(async (req: ToolCallReq) => {
      if (req.name === "vortex_act") {
        return { isError: true, content: [] };
      }
      return textResult("ok");
    });

    const def: CaseDefinition = {
      name: "hint-rate-empty-text",
      playgroundPath: "/#/hint",
      async run(ctx) {
        await ctx.call("vortex_act", { target: "@e3", action: "click" });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    // 分母 0（唯一的错误没有文本）→ 字段不写入，而不是写成 0
    expect(m.hintPresentRate).toBeUndefined();
    expect("hintPresentRate" in m).toBe(false);
  });

  it("空文本错误不拉低其它错误的比率", async () => {
    callToolMock.mockImplementation(async (req: ToolCallReq) => {
      if (req.name === "vortex_observe") {
        return { isError: true, content: [] };
      }
      if (req.name === "vortex_act") {
        return textResult("Error [INVALID_PARAMS]: target 缺失\nHint: 先 observe", true);
      }
      return textResult("ok");
    });

    const def: CaseDefinition = {
      name: "hint-rate-empty-text-mixed",
      playgroundPath: "/#/hint",
      async run(ctx) {
        await ctx.call("vortex_observe", {});
        await ctx.call("vortex_act", { target: "@e3", action: "click" });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.hintPresentRate).toBe(1);
  });
});

describe("refReuseRate", () => {
  it("一半 target 形如 @ref → 0.5", async () => {
    const def: CaseDefinition = {
      name: "ref-reuse-half",
      playgroundPath: "/#/ref",
      async run(ctx) {
        await ctx.call("vortex_act", { target: "@e3", action: "click" });
        await ctx.call("vortex_act", { target: ".el-button", action: "click" });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.refReuseRate).toBe(0.5);
  });

  it("target 全是 @ref → 1", async () => {
    const def: CaseDefinition = {
      name: "ref-reuse-all",
      playgroundPath: "/#/ref",
      async run(ctx) {
        await ctx.call("vortex_fill", { target: "@a1b2:e3", value: "hi" });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.refReuseRate).toBe(1);
  });

  it("没有带 target 的调用 → 分母为 0，字段不写入", async () => {
    const def: CaseDefinition = {
      name: "ref-reuse-none",
      playgroundPath: "/#/ref",
      async run(ctx) {
        await ctx.call("vortex_observe", { target: null });
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS_METRICS);

    expect(m.refReuseRate).toBeUndefined();
    expect("refReuseRate" in m).toBe(false);
  });
});

describe("suite 字段", () => {
  it("suite 缺省视为 a，本任务不实现 suite 过滤（suite=b 的 case 照常运行）", async () => {
    const def: CaseDefinition = {
      name: "suite-b-still-runs",
      playgroundPath: "/#/suite",
      suite: "b",
      async run(ctx) {
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(true);
  });
});
