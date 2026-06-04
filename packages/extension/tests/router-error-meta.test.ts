import { describe, it, expect } from "vitest";
import { VtxError, VtxErrorCode } from "@bytenew/vortex-shared";
import { ActionRouter } from "../src/lib/router.js";
import type { NmRequest } from "@bytenew/vortex-shared";

function mkReq(tool: string): NmRequest {
  return { type: "tool_request", tool, args: {}, requestId: "r-1" };
}

/**
 * 白盒审计批次 4 族 Q — ERR-1。
 *
 * router 对非 VtxError 的兜底原只按 message 子串猜 code,丢 hint/recoverable
 * (DEFAULT_ERROR_META 已为每个 code 定义 hint 却没回填)。CLI 等不经 server
 * 渲染层回填 hint 的消费者拿到的是无指引裸错。修复:兜底按推断出的 code 查
 * DEFAULT_ERROR_META 回填 hint + recoverable;VtxError 仍走原优先通道不变。
 */
describe("router 非 VtxError 兜底回填 DEFAULT_ERROR_META (ERR-1)", () => {
  it("raw Error('No tab...') → TAB_NOT_FOUND 且带 hint + recoverable", async () => {
    const r = new ActionRouter();
    r.register("x.fail", async () => { throw new Error("No tab with id 999"); });
    const resp = await r.dispatch(mkReq("x.fail"));
    expect(resp.error?.code).toBe(VtxErrorCode.TAB_NOT_FOUND);
    expect(resp.error?.message).toContain("No tab");
    expect(resp.error?.hint).toBeTruthy();
    expect(typeof resp.error?.recoverable).toBe("boolean");
  });

  it("raw Error('Cannot access...') → PERMISSION_DENIED 且带 hint", async () => {
    const r = new ActionRouter();
    r.register("x.fail", async () => { throw new Error("Cannot access chrome:// URL"); });
    const resp = await r.dispatch(mkReq("x.fail"));
    expect(resp.error?.code).toBe(VtxErrorCode.PERMISSION_DENIED);
    expect(resp.error?.hint).toBeTruthy();
  });

  it("普通 raw Error → JS_EXECUTION_ERROR 且带 hint", async () => {
    const r = new ActionRouter();
    r.register("x.fail", async () => { throw new Error("boom"); });
    const resp = await r.dispatch(mkReq("x.fail"));
    expect(resp.error?.code).toBe(VtxErrorCode.JS_EXECUTION_ERROR);
    expect(resp.error?.message).toBe("boom");
    expect(resp.error?.hint).toBeTruthy();
  });

  it("VtxError 仍走优先通道,保留自身 payload(不被兜底覆盖)", async () => {
    const r = new ActionRouter();
    r.register("x.fail", async () => {
      throw new VtxError(VtxErrorCode.ELEMENT_NOT_FOUND, "no element", { hint: "custom hint" });
    });
    const resp = await r.dispatch(mkReq("x.fail"));
    expect(resp.error?.code).toBe(VtxErrorCode.ELEMENT_NOT_FOUND);
    expect(resp.error?.hint).toBe("custom hint");
  });
});
