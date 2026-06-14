/**
 * TDD 测试集：getEventListeners 真值交互**发现**层（任务 T3，2026-06-14 重设计 + live 验证）
 *
 * 定位：pre-scan CDP DOMDebugger.getEventListeners 给纯 addEventListener 点击元素打
 * data-vtx-listener，scan 当入池信号 → DISCOVER 漏网 vanilla/jQuery div。
 *
 * 机制（live 实测唯一可用）：DOMDebugger.getEventListeners(document, depth:-1, pierce:true)
 * → 筛点击类 backendNodeId → DOM.getDocument（满足 push 前置）→ push → setAttributeValue。
 * CommandLineAPI getEventListeners 经 chrome.debugger 不暴露（typeof undefined），已移除。
 *
 * 测试覆盖：
 *   1. DOMDebugger 一次拿监听器 → 仅点击类 backendNodeId 被 push + 标记
 *   2. getEventListeners 用 depth:-1 + pierce:true；setAttributeValue 用 LISTENER_MARK_ATTR
 *   3. push **前**必调 DOM.getDocument（否则 "Document needs to be requested first"）
 *   4. 空 / 全非点击类监听器 → count 0
 *   5. CDP 抛错 / 无 document objectId → count 0 + mechanism=error（召回零回退）
 *   6. 常量 JS_LISTENER_ELEMENT_CAP / LISTENER_MARK_ATTR 存在
 *   7. 渲染层 [listener] 标记（listenerInteractive → 输出）
 */

import { describe, it, expect, vi } from "vitest";
import {
  markListenerElements,
  JS_LISTENER_ELEMENT_CAP,
  LISTENER_MARK_ATTR,
} from "../src/handlers/observe-js-listener.js";
import { renderObserveTree } from "../../mcp/src/lib/observe-render.js";

// --- 工具函数 ---

interface DbgConfig {
  /** DOMDebugger.getEventListeners 返回的监听器数组 */
  listeners?: Array<{ type?: string; backendNodeId?: number }>;
  /** pushNodesByBackendIdsToFrontend 返回的 nodeIds */
  nodeIds?: number[];
  /** 在指定 method 上抛错 */
  throwOn?: string;
  /** Runtime.evaluate("document") 不返回 objectId(模拟取 document 失败) */
  noDocObjectId?: boolean;
}

/** 构造按 method/params 分派的 DebuggerManager mock,按序记录每次 sendCommand。 */
function makeDbg(config: DbgConfig): {
  enableDomain: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  calls: Array<{ method: string; params: any }>;
} {
  const calls: Array<{ method: string; params: any }> = [];
  const sendCommand = vi.fn().mockImplementation((_tabId: number, method: string, params: any) => {
    calls.push({ method, params });
    if (config.throwOn && method === config.throwOn) throw new Error("CDP error");
    if (method === "Runtime.evaluate") {
      if (params?.expression === "document") {
        return Promise.resolve({ result: config.noDocObjectId ? {} : { objectId: "doc-oid" } });
      }
      return Promise.resolve({ result: { value: null } });
    }
    if (method === "DOMDebugger.getEventListeners") {
      return Promise.resolve({ listeners: config.listeners ?? [] });
    }
    if (method === "DOM.getDocument") {
      return Promise.resolve({ root: { nodeId: 1 } });
    }
    if (method === "DOM.pushNodesByBackendIdsToFrontend") {
      return Promise.resolve({ nodeIds: config.nodeIds ?? [] });
    }
    return Promise.resolve({});
  });
  const attach = vi.fn().mockResolvedValue(undefined);
  const enableDomain = vi.fn().mockResolvedValue(undefined);
  return { enableDomain, sendCommand, attach, calls };
}

// ---- DOMDebugger 发现路径 ----

describe("markListenerElements · DOMDebugger 发现", () => {
  it("一次拿监听器,仅点击类 backendNodeId 被 push + 标记", async () => {
    const dbg = makeDbg({
      listeners: [
        { type: "click", backendNodeId: 11 },
        { type: "mouseover", backendNodeId: 12 }, // 非点击类,忽略
        { type: "pointerup", backendNodeId: 13 },
      ],
      nodeIds: [101, 103],
    });
    const res = await markListenerElements(dbg as any, 1);
    expect(res.mechanism).toBe("domDebugger");
    expect(res.count).toBe(2); // 两个 nodeId 各 setAttributeValue 一次
    // 仅点击类 backendNodeId(11,13)进入 push,非点击类 12 被滤掉
    const pushCall = dbg.calls.find((c) => c.method === "DOM.pushNodesByBackendIdsToFrontend");
    expect(pushCall!.params.backendNodeIds.sort()).toEqual([11, 13]);
  });

  it("getEventListeners 用 depth:-1 + pierce:true;setAttributeValue 用 LISTENER_MARK_ATTR", async () => {
    const dbg = makeDbg({ listeners: [{ type: "click", backendNodeId: 7 }], nodeIds: [70] });
    await markListenerElements(dbg as any, 1);
    const leCall = dbg.calls.find((c) => c.method === "DOMDebugger.getEventListeners");
    expect(leCall!.params.depth).toBe(-1);
    expect(leCall!.params.pierce).toBe(true);
    const setCall = dbg.calls.find((c) => c.method === "DOM.setAttributeValue");
    expect(setCall!.params.name).toBe(LISTENER_MARK_ATTR);
  });

  it("push **前**必调 DOM.getDocument(满足「文档须先请求」前置)", async () => {
    const dbg = makeDbg({ listeners: [{ type: "click", backendNodeId: 7 }], nodeIds: [70] });
    await markListenerElements(dbg as any, 1);
    const order = dbg.calls.map((c) => c.method);
    const getDocIdx = order.indexOf("DOM.getDocument");
    const pushIdx = order.indexOf("DOM.pushNodesByBackendIdsToFrontend");
    expect(getDocIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThan(getDocIdx); // getDocument 在 push 之前
  });

  it("空监听器 → count 0,且不触发 getDocument/push", async () => {
    const dbg = makeDbg({ listeners: [] });
    const res = await markListenerElements(dbg as any, 1);
    expect(res.mechanism).toBe("domDebugger");
    expect(res.count).toBe(0);
    expect(dbg.calls.some((c) => c.method === "DOM.getDocument")).toBe(false);
  });

  it("仅非点击类监听器 → count 0(全滤掉)", async () => {
    const dbg = makeDbg({
      listeners: [
        { type: "mouseover", backendNodeId: 1 },
        { type: "focus", backendNodeId: 2 },
      ],
    });
    const res = await markListenerElements(dbg as any, 1);
    expect(res.count).toBe(0);
  });
});

// ---- 召回零回退 ----

describe("markListenerElements · 召回零回退", () => {
  it("无 document objectId → count 0 + mechanism=error", async () => {
    const dbg = makeDbg({ noDocObjectId: true });
    const res = await markListenerElements(dbg as any, 1);
    expect(res.count).toBe(0);
    expect(res.mechanism).toBe("error");
  });

  it("getEventListeners 抛错 → count 0 + error,不抛", async () => {
    const dbg = makeDbg({ throwOn: "DOMDebugger.getEventListeners" });
    const res = await markListenerElements(dbg as any, 1);
    expect(res.count).toBe(0);
    expect(res.mechanism).toBe("error");
  });

  it("从不返回 commandLineAPI 机制(该路径已移除)", async () => {
    const dbg = makeDbg({ listeners: [{ type: "click", backendNodeId: 7 }], nodeIds: [70] });
    const res = await markListenerElements(dbg as any, 1);
    expect(res.mechanism).not.toBe("commandLineAPI");
  });

  it("JS_LISTENER_ELEMENT_CAP 为正整数(参考 browser-use ~10000)", () => {
    expect(JS_LISTENER_ELEMENT_CAP).toBeGreaterThan(0);
    expect(Number.isInteger(JS_LISTENER_ELEMENT_CAP)).toBe(true);
  });

  it("LISTENER_MARK_ATTR 是 data-vtx-listener", () => {
    expect(LISTENER_MARK_ATTR).toBe("data-vtx-listener");
  });
});

// ---- 渲染层 [listener] 标记(未变,回归保护)----

describe("observe-render [listener] 标记", () => {
  it("listenerInteractive=true → 渲染输出含 [listener]", () => {
    const data = {
      snapshotId: "s1",
      url: "https://example.com",
      elements: [
        { index: 0, tag: "div", role: "div", name: "自定义按钮", frameId: 0, listenerInteractive: true },
      ],
    };
    const out = renderObserveTree(data as any, null);
    expect(out).toContain("[listener]");
  });

  it("reactClickable=true 且 listenerInteractive=true → 同时含 [cursor=pointer] 和 [listener]", () => {
    const data = {
      snapshotId: "s1",
      url: "https://example.com",
      elements: [
        {
          index: 0,
          tag: "div",
          role: "div",
          name: "React 按钮",
          frameId: 0,
          reactClickable: true as const,
          listenerInteractive: true,
        },
      ],
    };
    const out = renderObserveTree(data as any, null);
    expect(out).toContain("[cursor=pointer]");
    expect(out).toContain("[listener]");
  });

  it("无 listenerInteractive → 不含 [listener]", () => {
    const data = {
      snapshotId: "s1",
      url: "https://example.com",
      elements: [{ index: 0, tag: "button", role: "button", name: "提交", frameId: 0 }],
    };
    const out = renderObserveTree(data as any, null);
    expect(out).not.toContain("[listener]");
  });
});
