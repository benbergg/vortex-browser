// query 的元素寻址接线:@ref 经 MCP 翻译后到达扩展的形态是 index+snapshotId。
// 纯函数测试证明不了接线,这里全部走 router.dispatch 断言真实注入实参。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerQueryHandlers } from "../src/handlers/query.js";
import { newSnapshotId, setSnapshot } from "../src/lib/snapshot-store.js";

function mkReq(args: Record<string, unknown>, requestId: string): NmRequest {
  return { type: "tool_request", tool: "query.queryPage", args, requestId, tabId: 42 };
}

function putSnap(frameId: number, index: number, selector: string): string {
  const id = newSnapshotId();
  setSnapshot(id, {
    tabId: 42,
    frameId,
    capturedAt: Date.now(),
    elements: [{ index, selector, frameId, role: "link", name: "Start for free" }],
  });
  return id;
}

describe("query 经 index+snapshotId 定位（@ref 翻译后的形态）", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn().mockResolvedValue([
      { result: { elements: [{ index: 0, tag: "h1" }], total: 1, showing: 1 } },
    ]);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://x/" },
          { frameId: 7, parentFrameId: 0, url: "https://x/f" },
        ]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerQueryHandlers(router);
  });

  it("不传 pattern、只传 index+snapshotId → 用快照里的 selector 当 pattern", async () => {
    const snapshotId = putSnap(0, 3, ".css-m7knwo");
    const resp = await router.dispatch(mkReq({ mode: "style", index: 3, snapshotId }, "r1"));

    expect(resp.error).toBeUndefined();
    expect(executeScript.mock.calls[0][0].args[0]).toBe(".css-m7knwo");
  });

  it("跨 frame 快照 → executeScript 打的是快照绑定的 frame", async () => {
    const snapshotId = putSnap(7, 1, ".in-iframe");
    await router.dispatch(mkReq({ mode: "style", index: 1, snapshotId }, "r1b"));

    // 只断言 selector 反查是不够的:boundFrameId 接线断掉时上一条仍全绿
    expect(executeScript.mock.calls[0][0].target.frameIds).toEqual([7]);
  });

  it("既不传 pattern 也不传 index → 仍报 pattern 必填", async () => {
    const resp = await router.dispatch(mkReq({ mode: "style" }, "r2"));
    expect(String(resp.error?.message)).toMatch(/pattern is required/);
  });
  it("attr 选组真的传到了页面侧探针的第三个实参", async () => {
    await router.dispatch(mkReq({ mode: "style", pattern: "h1", attr: "typography" }, "r4"));
    expect(executeScript.mock.calls[0][0].args[2]).toEqual(["typography"]);
  });

  it("不传 attr → 六组全开(pseudo/font 也在缺省里,不然盲区还在)", async () => {
    await router.dispatch(mkReq({ mode: "style", pattern: "h1" }, "r5"));
    expect(executeScript.mock.calls[0][0].args[2]).toEqual([
      "typography", "box", "paint", "motion", "pseudo", "font",
    ]);
  });

  it("非法组名 → 报错而不是静默返回空分组", async () => {
    const resp = await router.dispatch(mkReq({ mode: "style", pattern: "h1", attr: "colours" }, "r6"));
    expect(String(resp.error?.message)).toMatch(/attr must be one or more of/);
  });
  it("pattern 为空串 + 有效 ref → 空串按没给算,回退到 ref", async () => {
    const snapshotId = putSnap(0, 5, ".from-ref");
    const resp = await router.dispatch(mkReq({ mode: "style", pattern: "   ", index: 5, snapshotId }, "r9"));
    expect(resp.error).toBeUndefined();
    expect(executeScript.mock.calls[0][0].args[0]).toBe(".from-ref");
  });

  it("非空 pattern 与 index 并存 → INVALID_PARAMS,不注入", async () => {
    const snapshotId = putSnap(0, 5, ".from-ref");
    const resp = await router.dispatch(mkReq({ mode: "style", pattern: "h1", index: 5, snapshotId }, "r10"));
    expect(String(resp.error?.message)).toMatch(/not both/);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("快照过期 → STALE_SNAPSHOT 传播给调用方,不注入", async () => {
    const resp = await router.dispatch(mkReq({ mode: "style", index: 1, snapshotId: "snap_gone" }, "r11"));
    expect(resp.error?.code).toBe(VtxErrorCode.STALE_SNAPSHOT);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("index 不在快照里 → INVALID_INDEX 传播给调用方,不注入", async () => {
    const snapshotId = putSnap(0, 5, ".from-ref");
    const resp = await router.dispatch(mkReq({ mode: "style", index: 99, snapshotId }, "r12"));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_INDEX);
    expect(executeScript).not.toHaveBeenCalled();
  });
  it("mode=tokens 注入的是 tokensProbeFunc,实参是 [pattern, maxPerGroup]", async () => {
    const { tokensProbeFunc } = await import("../src/handlers/query.js");
    executeScript.mockResolvedValue([{ result: { roots: [":root"], total: 0, showing: 0, groups: {} } }]);
    await router.dispatch(mkReq({ mode: "tokens", pattern: "colors", maxResults: 12 }, "r13"));
    const call = executeScript.mock.calls[0][0];
    // 注错探针 / 把 maxResults 当别的用 / pattern 传丢,这三种都在这里转红
    expect(call.func).toBe(tokensProbeFunc);
    expect(call.args).toEqual(["colors", 12]);
  });

  it("mode=tokens 不传 maxResults → 每组默认 40", async () => {
    executeScript.mockResolvedValue([{ result: { roots: [":root"], total: 0, showing: 0, groups: {} } }]);
    await router.dispatch(mkReq({ mode: "tokens", pattern: "*" }, "r14"));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(40);
  });

  it("mode=tokens 零命中 → 带自陈说明为什么空", async () => {
    executeScript.mockResolvedValue([{ result: { roots: [], total: 0, showing: 0, groups: {} } }]);
    const resp = await router.dispatch(mkReq({ mode: "tokens", pattern: "*" }, "r15"));
    expect(resp.error).toBeUndefined();
    expect(JSON.stringify(resp.result)).toMatch(/compile design tokens away at build time/);
  });
  it("mode=tokens maxResults 为负 → handler 归一到 1", async () => {
    executeScript.mockResolvedValue([{ result: { roots: [], total: 0, showing: 0, groups: {}, truncatedGroups: {} } }]);
    await router.dispatch(mkReq({ mode: "tokens", pattern: "*", maxResults: -1 }, "r16"));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(1);
  });
});
