import { describe, it, expect } from "vitest";
import { registerDiagnosticsHandlers } from "../src/handlers/diagnostics.js";
import { ActionRouter } from "../src/lib/router.js";
import { DiagnosticsActions } from "@vortex-browser/shared";

/**
 * diagnostics.version 须带 buildStamp:dev-reload 靠它验证 chrome.runtime.reload()
 * 后扩展确实换到了新 dist(戳变 = 新代码生效)。单测环境 __VORTEX_BUILD__ 未注入 →
 * 回退 "dev",但字段必须存在,否则 MCP 轮询永远拿不到戳。
 */
describe("diagnostics.version buildStamp", () => {
  it("VERSION 结果含 buildStamp 字段(未注入回退 dev)", async () => {
    const router = new ActionRouter();
    registerDiagnosticsHandlers(router);
    const resp = await router.dispatch({
      type: "tool_request",
      tool: DiagnosticsActions.VERSION,
      args: {},
      requestId: "t-1",
    });
    expect(resp.type).toBe("tool_response");
    const result = (resp as { result: Record<string, unknown> }).result;
    expect(result).toHaveProperty("buildStamp");
    expect(typeof result.buildStamp).toBe("string");
    expect((result.buildStamp as string).length).toBeGreaterThan(0);
  });
});
