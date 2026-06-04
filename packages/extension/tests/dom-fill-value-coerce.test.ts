import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@bytenew/vortex-shared";
import { VtxErrorCode, DomActions } from "@bytenew/vortex-shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";

/**
 * 回归锁:FILL value 非 string 的处理(2026-06-04 多 agent 审计 #nv,LIVE 确认)。
 *
 * 现象:schema 的 value 允许任意 JSON,`vortex_act(fill, value:{a:1})` 把对象一路
 *   传到 page-side,原生 value setter 把它 String 化写成 "[object Object]" readback
 *   非空 → success:true,静默写入垃圾。
 *
 * 修复:handler 入口拒绝对象/数组 value(INVALID_PARAMS,响亮指引),number/boolean
 *   等标量经 String() 强转为正常字符串下传。该校验在 getActiveTabId 之前,故无需
 *   chrome stub 即可行为验证拒绝路径。
 */
function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.FILL, args, requestId: "r-1" };
}

describe("FILL value 非 string 强转/拒绝 (2026-06-04 审计 #nv)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    router = new ActionRouter();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as any;
    registerDomHandlers(router, debuggerMgr);
  });

  it("对象 value → INVALID_PARAMS(不静默写 [object Object])", async () => {
    const resp = await router.dispatch(
      mkReq({ selector: "#x", value: { a: 1 } }),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });

  it("数组 value → INVALID_PARAMS", async () => {
    const resp = await router.dispatch(
      mkReq({ selector: "#x", value: [1, 2] }),
    );
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });

  it("缺失 value → 仍 INVALID_PARAMS(原有契约不退化)", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#x" }));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });
});
