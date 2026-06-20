import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerStorageHandlers } from "../src/handlers/storage.js";

/**
 * GET_SESSION_STORAGE maxLength 截断不对称回归锁(白盒实机复现,2026-06-20)。
 *
 * 现象:GET_LOCAL_STORAGE(BUG-002)有 maxLength + truncate + VORTEX_TRUNCATED trailer,
 *   而 sibling 路径 GET_SESSION_STORAGE 完全没有——大 sessionStorage value 被 MCP 传输层
 *   静默截断,无 trailer 无信号,agent 误读为完整(silent false-negative)。dispatch 层
 *   (dispatch.ts:315)已把 maxLength 传给 storage.getSessionStorage,但 handler 从不读。
 *   live: example.com 注入 20000 字符同值,op:get 截到 10240+trailer,op:session-get 原样
 *   返回 20000 无 trailer。
 *
 * 修复:GET_SESSION_STORAGE 对齐 GET_LOCAL_STORAGE,加 maxLength 校验 + 内联 truncate。
 */
class StubStorage implements Storage {
  private store: Record<string, string>;
  length = 0;
  constructor(init: Record<string, string>) {
    this.store = { ...init };
    this.length = Object.keys(init).length;
  }
  key(i: number): string | null { return Object.keys(this.store)[i] ?? null; }
  getItem(k: string): string | null { return this.store[k] ?? null; }
  setItem(k: string, v: string): void { this.store[k] = v; this.length = Object.keys(this.store).length; }
  removeItem(k: string): void { delete this.store[k]; this.length = Object.keys(this.store).length; }
  clear(): void { this.store = {}; this.length = 0; }
}

interface NmRequest {
  type: "tool_request";
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  tabId: number;
}
function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

describe("GET_SESSION_STORAGE maxLength 截断(对齐 localStorage BUG-002)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("sessionStorage", new StubStorage({ small: "x", big: "y".repeat(20000) }));
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerStorageHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  // 捕获注入到 page-side 的 func,在 Node 侧用 stub sessionStorage 真跑(逻辑须含截断)。
  async function captureFunc(): Promise<(k: string | null, ml?: number) => { result?: unknown; error?: string }> {
    executeScript.mockResolvedValue([{ result: { result: null } }]);
    await router.dispatch(mkReq("storage.getSessionStorage", {}, 42));
    const fn = executeScript.mock.calls[0][0].func;
    executeScript.mockClear();
    return fn;
  }

  it("传 key='big' + maxLength=100 → 截断 + trailer", async () => {
    const fn = await captureFunc();
    const out = fn("big", 100);
    expect(out.result).toMatch(/^y{100}\n\n\[VORTEX_TRUNCATED original=20000 limit=100\]/);
  });

  it("传 key='big' + 不传 maxLength → 默认 10240 截断 + trailer", async () => {
    const fn = await captureFunc();
    const out = fn("big", undefined);
    expect((out.result as string).length).toBeLessThanOrEqual(10240 + 200);
    expect(out.result).toMatch(/\[VORTEX_TRUNCATED original=20000 limit=10240\]/);
  });

  it("传 key='small' → 返完整(未超限)", async () => {
    const fn = await captureFunc();
    const out = fn("small", undefined);
    expect(out.result).toBe("x");
  });

  it("无 key(全量) + maxLength=50 → values 截断,keys 不受影响", async () => {
    const fn = await captureFunc();
    const out = fn(null, 50);
    const r = out.result as Record<string, string>;
    expect(r.big).toMatch(/\[VORTEX_TRUNCATED original=20000 limit=50\]/);
    expect(r.small).toBe("x");
  });

  it("maxLength=0 或负数 → handler 抛 INVALID_PARAMS", async () => {
    const out1 = (await router.dispatch(
      mkReq("storage.getSessionStorage", { key: "small", maxLength: 0 }, 42),
    )) as { error?: { code: string; message: string } };
    expect(out1.error?.code).toBe("INVALID_PARAMS");
    expect(out1.error?.message).toMatch(/maxLength/i);

    const out2 = (await router.dispatch(
      mkReq("storage.getSessionStorage", { key: "small", maxLength: -1 }, 42),
    )) as { error?: { code: string } };
    expect(out2.error?.code).toBe("INVALID_PARAMS");
  });
});
