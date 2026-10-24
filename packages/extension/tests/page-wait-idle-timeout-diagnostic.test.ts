/**
 * Author: qingwa
 * Description: awaitIdle 超时的**诊断可见性**（A6）——agent 必须能在**错误文本**里
 * 看到 requestId / url / type / lastMatchedAgoMs / idleTime。
 *
 * 为什么必须是「错误文本」而不是 extras：
 *   MCP 侧 packages/mcp/src/lib/dispatch-error.ts 的 formatDispatchError **不序列化
 *   extras**（只出 `Error [CODE]: message` + hint）。extras 只有 MCP 进程内的程序
 *   读得到，**agent 读不到** ⇒ 只把诊断放 extras 等于没透出。
 *
 * 本文件走**真实链路**：
 *   真 awaitIdle（发真 CDP 事件、真的超时）
 *     → 真 router（VtxError.toJSON）
 *       → 真 formatDispatchError（packages/mcp/src/lib/dispatch-error.ts）
 *         → 断言**最终文本**里能搜到 requestId / url / type / lastMatchedAgoMs / idleTime。
 *
 * 跨包 import 是既有先例（tests/observe-js-listener.test.ts 就 import 了
 * ../../mcp/src/lib/observe-render.js），此处同理：断言必须打真实的 formatter，
 * 自己重写一份等价逻辑等于没测。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";
import { formatDispatchError } from "../../mcp/src/lib/dispatch-error.js";

type CdpEventCallback = (
  tabId: number,
  method: string,
  params: unknown,
) => void;

const TAB = 42;
/** 待诊断的那条「永不结束」的请求。 */
const PENDING_REQ_ID = "pending-diag-1";
const PENDING_URL = "https://diag.test/api/never-ends";
const PENDING_TYPE = "Fetch";

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

function makeDebuggerMock() {
  const callbacks: CdpEventCallback[] = [];
  const onEvent = vi.fn((cb: CdpEventCallback) => {
    callbacks.push(cb);
  });
  const offEvent = vi.fn((cb: CdpEventCallback) => {
    const i = callbacks.indexOf(cb);
    if (i >= 0) callbacks.splice(i, 1);
  });
  return {
    mgr: {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      onEvent,
      offEvent,
      sendCommand: vi.fn(),
      attach: vi.fn().mockResolvedValue(undefined),
      isAttached: vi.fn().mockReturnValue(true),
    } as any,
    fire(tabId: number, method: string, params: unknown) {
      for (const cb of [...callbacks]) cb(tabId, method, params);
    },
  };
}

// 排空 enableDomain 的 microtask，让 awaitIdle 注册完 CDP 监听器
async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("awaitIdle 超时诊断：agent 在错误文本里就能看到 pending 明细与静默期参数", () => {
  let router: ActionRouter;
  let dbg: ReturnType<typeof makeDebuggerMock>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    router = new ActionRouter();
    dbg = makeDebuggerMock();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: TAB }]),
        get: vi.fn(),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        reload: vi.fn(),
      },
    });
    registerPageHandlers(router, dbg.mgr);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 造一个「有 pending 请求 + 持续噪声 ⇒ 超时」的场景，返回 router 的响应。 */
  async function runTimeoutScenario() {
    const p = router.dispatch(
      mkReq("page.waitForNetworkIdle", { idleTime: 300, timeout: 600 }, TAB),
    );
    await flush();

    // 一条永不结束的匹配请求 ⇒ 进 pending 明细
    dbg.fire(TAB, "Network.requestWillBeSent", {
      requestId: PENDING_REQ_ID,
      type: PENDING_TYPE,
      request: { url: PENDING_URL },
    });
    // 持续噪声把静默计时器顶住 ⇒ 拖到超时
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100);
      dbg.fire(TAB, "Network.requestWillBeSent", {
        requestId: `noise-${i}`,
        type: "XHR",
        request: { url: `/api/noise/${i}` },
      });
    }
    await vi.advanceTimersByTimeAsync(200);
    return await p;
  }

  it("经过真实 formatter 的最终文本里有 requestId / url / type / lastMatchedAgoMs / idleTime", async () => {
    const resp = await runTimeoutScenario();
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(resp.error).toBeDefined();

    // ★ 走**真实**的 MCP 错误格式化（agent 实际收到的那串文本）
    const finalText = formatDispatchError(resp.error!);

    // requestId：agent 拿去和 debug_read(source=network) 日志对上的句柄
    expect(finalText).toContain(PENDING_REQ_ID);
    // url
    expect(finalText).toContain(PENDING_URL);
    // type
    expect(finalText).toContain(PENDING_TYPE);
    // 静默期参数：idleTime 与「距最后一次匹配请求过了多久」
    expect(finalText).toContain("idleTime=300ms");
    expect(finalText).toMatch(/lastMatchedAgoMs=\d+ms/);
    // 错误码与 hint 也得在（格式化器没把诊断吃掉）
    expect(finalText).toContain(`Error [${VtxErrorCode.TIMEOUT}]`);
  });

  it("extras 保留兼容字段 pending（数量）并新增结构化明细数组 pendingDetails", async () => {
    const resp = await runTimeoutScenario();
    const extras = resp.error?.context?.extras as
      | {
          pending?: unknown;
          pendingDetails?: unknown;
          idleTime?: unknown;
          lastMatchedAgoMs?: unknown;
        }
      | undefined;

    // 兼容字段：pending 仍是数字（navigate 的 pendingFromError 按 number 读它）
    expect(typeof extras?.pending).toBe("number");
    expect(extras?.pending as number).toBeGreaterThanOrEqual(1);

    // 新增：结构化明细数组，每项含 requestId / url / type
    expect(Array.isArray(extras?.pendingDetails)).toBe(true);
    const details = extras?.pendingDetails as Array<{
      requestId: string;
      url: string;
      type: string;
    }>;
    const hit = details.find((d) => d.requestId === PENDING_REQ_ID);
    expect(hit, "pending 明细里必须能按 requestId 找到那条挂着的请求").toBeDefined();
    expect(hit!.url).toBe(PENDING_URL);
    expect(hit!.type).toBe(PENDING_TYPE);

    // 静默期参数也留在 extras 里（程序可读）
    expect(extras?.idleTime).toBe(300);
    expect(typeof extras?.lastMatchedAgoMs).toBe("number");
  });
});
