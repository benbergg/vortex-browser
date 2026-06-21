import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";

/**
 * vortex_wait_for mode=custom 在隐藏 tab(active:false)挂死(白盒+DAST 双证,2026-06-20)。
 *
 * 缺陷(silent-hang → silent-false-negative + 误导性传输超时):
 *   WAIT_FOR_EXPRESSION 的 page-side poll 用 `setTimeout(() => requestAnimationFrame(poll))`
 *   调度。隐藏 tab(document.visibilityState='hidden',正是 agent 隔离常态 active:false)里
 *   requestAnimationFrame 回调被浏览器冻结(不合成不回调) → poll 体(含超时判定 + 重新求值)
 *   永不执行 → page-side promise 挂死,直到 MCP 传输层超时(误导成 "no response / Extension
 *   not loaded")。后果:① 永不真假成功(条件后续变真也检测不到 = silent-false-negative);
 *   ② 干净的 `[TIMEOUT]: Expression never resolved truthy` 被晦涩传输超时取代。
 *
 *   DAST 实机复现(example.com active:false 隐藏 tab):
 *     wait_for(custom, '() => false', timeout=1500) → 6500ms "no response"(应为 ~1500ms 干净 TIMEOUT);
 *     spike 证实隐藏 tab requestAnimationFrame 600ms 内 rafFired=false / setTimeout toFired=true;
 *     element 模式(纯 setTimeout 计时)同条件下干净 [TIMEOUT]@1500ms,佐证根因是 rAF。
 *
 * 修复:poll 调度去掉 requestAnimationFrame,改纯 `setTimeout(poll, intervalMs)`
 *   (与 page.wait / dom.waitSettled 既有惯例一致;rAF 对轮询 JS 表达式无价值)。
 *
 * 注:既有 wait-for-custom-iife.test.ts 把 rAF stub 成 setTimeout(cb,0) 总会触发,
 *   故掩盖了本 bug —— 本测试显式把 rAF 设为 no-op 复刻隐藏 tab 冻结。
 */

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

describe("vortex_wait_for mode=custom — 隐藏 tab rAF 冻结仍须超时(不挂死)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://x/" },
        ]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerPageHandlers(router);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as any).requestAnimationFrame;
  });

  // 捕获真实注入的 page-side func（与 wait-for-custom-iife.test.ts 同惯例）
  async function captureFunc() {
    executeScript.mockResolvedValue([
      { result: { ok: false, waitedMs: 50 } },
    ]);
    try {
      await router.dispatch(mkReq("page.waitForExpression", { expression: "false", timeout: 100 }, 42));
    } catch {}
    const fn = executeScript.mock.calls[0][0].func as (
      e: string,
      t: number,
      i: number,
    ) => Promise<{ ok: boolean; value?: unknown; waitedMs: number; error?: string }>;
    executeScript.mockClear();
    return fn;
  }

  it("rAF 永不触发(隐藏 tab)→ 'false' 仍在 timeout 后 resolve ok:false,不挂死", async () => {
    const fn = await captureFunc();
    // 隐藏 tab:requestAnimationFrame 注册回调但永不调用（浏览器冻结合成）
    (globalThis as any).requestAnimationFrame = () => 0;
    const guard = new Promise<"HANG">((res) => setTimeout(() => res("HANG"), 1500));
    const r = await Promise.race([fn("false", 80, 10), guard]);
    expect(r).not.toBe("HANG"); // 核心:不能挂死等到传输超时
    expect((r as { ok: boolean }).ok).toBe(false);
  });

  it("rAF 永不触发(隐藏 tab)→ 后续变真的表达式仍能检测到 ready(非 false-negative)", async () => {
    const fn = await captureFunc();
    (globalThis as any).requestAnimationFrame = () => 0;
    // 表达式 200ms 后变真：poll 必须在隐藏 tab 持续轮询才能捕获
    (globalThis as any).__vtxReady = false;
    setTimeout(() => { (globalThis as any).__vtxReady = true; }, 200);
    const guard = new Promise<"HANG">((res) => setTimeout(() => res("HANG"), 2000));
    const r = await Promise.race([fn("globalThis.__vtxReady === true", 1500, 20), guard]);
    delete (globalThis as any).__vtxReady;
    expect(r).not.toBe("HANG");
    expect((r as { ok: boolean }).ok).toBe(true);
  });

  it("可见 tab(rAF 正常)→ 行为不回归:'false' 超时 ok:false", async () => {
    const fn = await captureFunc();
    (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    const r = await fn("false", 60, 10);
    expect(r.ok).toBe(false);
  });
});
