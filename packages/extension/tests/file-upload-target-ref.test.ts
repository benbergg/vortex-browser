import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { FileActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerFileHandlers } from "../src/handlers/file.js";
import { setSnapshot } from "../src/lib/snapshot-store.js";

/**
 * DESIGN-001 (N0063): vortex_file_upload 支持 @ref(target)。server.ts 把 @ref 翻成
 * index+snapshotId 后,file.upload handler 须经 resolveTarget 反查 selector(与其它 14
 * 工具一致),而非只读 args.selector。历史实现只认 args.selector → @ref 场景必报
 * "Missing required params"。
 */
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(7),
  buildExecuteTarget: vi.fn((tabId: number) => ({ tabId })),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: FileActions.UPLOAD, args, requestId: "r-1" } as NmRequest;
}

describe("file.upload @ref 解析 (DESIGN-001 N0063)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    executeScript = vi.fn().mockResolvedValue([{ result: { result: { success: true, fileName: "t.txt", size: 4 } } }]);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 7 }]) },
      scripting: { executeScript },
      downloads: { onChanged: { addListener: vi.fn() }, search: vi.fn() },
    };
    router = new ActionRouter();
    const nm = { send: vi.fn() } as never;
    const dispatcher = { emit: vi.fn() } as never;
    registerFileHandlers(router, nm, dispatcher);
  });

  it("index+snapshotId(来自 @ref 翻译)→ resolveTarget 反查 selector 传给 executeScript", async () => {
    setSnapshot("snap_f", {
      tabId: 7,
      capturedAt: Date.now(),
      elements: [{ index: 9, selector: "#file" }],
    });
    const resp = await router.dispatch(
      mkReq({ index: 9, snapshotId: "snap_f", fileName: "t.txt", fileContent: "dGVzdA==" }),
    );
    expect(resp.error).toBeUndefined();
    expect(executeScript).toHaveBeenCalledTimes(1);
    // 反查出的 selector "#file" 作 args[0] 传入 page-side func
    expect(executeScript.mock.calls[0][0].args[0]).toBe("#file");
  });

  it("裸 selector(向后兼容)仍工作", async () => {
    const resp = await router.dispatch(
      mkReq({ selector: "#file2", fileName: "t.txt", fileContent: "dGVzdA==" }),
    );
    expect(resp.error).toBeUndefined();
    expect(executeScript.mock.calls[0][0].args[0]).toBe("#file2");
  });
});
