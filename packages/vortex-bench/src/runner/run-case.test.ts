// runCase 的防假绿闸门 + 三个新指标（assertionCount / hintPresentRate / refReuseRate）。
//
// 为什么 mock mcp-client：闸门与指标口径全在 runner 侧（ctx.assert 计数、trace 事件统计），
// 与真实 MCP stdio 进程无关。mock 掉 stdio 连接后单测是秒级的，不依赖 playground 常驻，
// 也不依赖 vortex-mcp 二进制存在。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CaseDefinition } from "../types.js";
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

function textResult(text: string, isError = false): unknown {
  return { isError, content: [{ text }] };
}

beforeEach(() => {
  callToolMock.mockReset();
  callToolMock.mockImplementation(async (_req: ToolCallReq) => textResult("ok"));
});

describe("runCase 防假绿闸门", () => {
  it("用例一条断言都没做 → passed=false / failureClass=assertion_failure / assertionCount=0", async () => {
    const def: CaseDefinition = {
      name: "gate-no-assertion",
      playgroundPath: "/#/noop",
      // 故意不做任何断言：老实现下这个 case 会 passed=true（假绿）
      async run() {},
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(false);
    expect(m.failureClass).toBe("assertion_failure");
    expect(m.assertionCount).toBe(0);
    expect(m.failureReason).toContain("未产生任何断言");
  });

  it("用例做过断言 → 正常通过，assertionCount 记真实次数", async () => {
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
    expect(m.assertionCount).toBe(2);
    expect(m.failureClass).toBeUndefined();
  });

  it("断言失败 → 仍是 assertion_failure，且失败的那次断言也计数", async () => {
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
    expect(m.assertionCount).toBe(1);
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

    const m = await runCase(def, OPTS);

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

    const m = await runCase(def, OPTS);

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

    const m = await runCase(def, OPTS);

    expect(m.hintPresentRate).toBeUndefined();
    expect("hintPresentRate" in m).toBe(false);
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

    const m = await runCase(def, OPTS);

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

    const m = await runCase(def, OPTS);

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

    const m = await runCase(def, OPTS);

    expect(m.refReuseRate).toBeUndefined();
    expect("refReuseRate" in m).toBe(false);
  });
});

describe("suite 字段", () => {
  // 契约：suite 字段**只为 suite B 写入**。suite A 的序列化必须与加这个字段之前逐字节一致
  // （既有 baseline.json 是按 suite A 的形状生成的，多一个键就是回归）。
  it("suite 缺省（suite A）→ 报告里不出现 suite 字段", async () => {
    const def: CaseDefinition = {
      name: "suite-a-default",
      playgroundPath: "/#/suite",
      async run(ctx) {
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS);

    expect(m.passed).toBe(true);
    expect("suite" in m).toBe(false);
    expect(m.suite).toBeUndefined();
  });

  it("显式写 suite: \"a\" 也不写进报告（suite A 的形状保持原样）", async () => {
    const def: CaseDefinition = {
      name: "suite-a-explicit",
      playgroundPath: "/#/suite",
      suite: "a",
      async run(ctx) {
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS);

    expect("suite" in m).toBe(false);
  });

  it("suite: \"b\" → 写 suite: \"b\"（报告按它分档）", async () => {
    const def: CaseDefinition = {
      name: "suite-b",
      playgroundPath: "/#/suite",
      suite: "b",
      async run(ctx) {
        ctx.assert(true, "ok");
      },
    };

    const m = await runCase(def, OPTS);

    expect(m.suite).toBe("b");
  });

  it("suite=b 的 case 照常运行（过滤在 CLI 层做，runner 不拦）", async () => {
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
    expect(m.assertionCount).toBe(1);
  });
});
