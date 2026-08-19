// query 的元素寻址接线:@ref 经 MCP 翻译后到达扩展的形态是 index+snapshotId。
// 纯函数测试证明不了接线,这里全部走 router.dispatch 断言真实注入实参。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
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

  it("不传 attr → 四组全开", async () => {
    await router.dispatch(mkReq({ mode: "style", pattern: "h1" }, "r5"));
    expect(executeScript.mock.calls[0][0].args[2]).toEqual(["typography", "box", "paint", "motion"]);
  });

  it("非法组名 → 报错而不是静默返回空分组", async () => {
    const resp = await router.dispatch(mkReq({ mode: "style", pattern: "h1", attr: "colours" }, "r6"));
    expect(String(resp.error?.message)).toMatch(/attr must be one or more of/);
  });
});
