// @vitest-environment jsdom
// 组合模式的 handler 层行为:维度校验、上限、维度自陈。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerQueryHandlers } from "../src/handlers/query.js";
import { gcSnapshots, getSnapshotEntry } from "../src/lib/snapshot-store.js";

let router: ActionRouter;
let executeScript: ReturnType<typeof vi.fn>;

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "query.queryPage", args, requestId: "r1", tabId: 42 };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  router = new ActionRouter();
  executeScript = vi.fn();
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
    scripting: { executeScript },
    runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
  });
  registerQueryHandlers(router);
});

describe("mode=elements 维度校验", () => {
  it("非法维度名直接报错,不静默忽略", async () => {
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".x", dimensions: "geometry,nosuch" }));
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/nosuch/);
  });

  it("不传 dimensions 时默认 geometry+text,不是全维度", async () => {
    executeScript.mockResolvedValueOnce([{ result: { elements: [], total: 0, showing: 0, scanned: { elements: 1, shadowRoots: 0, iframes: 0 } } }]);
    await router.dispatch(mkReq({ mode: "elements", pattern: ".x" }));
    const dims = executeScript.mock.calls[0][0].args[2] as string[];
    expect(dims.sort()).toEqual(["geometry", "text"]);
  });

  it("maxResults 默认 20、上限 50,不因维度改变", async () => {
    executeScript.mockResolvedValue([{ result: { elements: [], total: 0, showing: 0, scanned: { elements: 1, shadowRoots: 0, iframes: 0 } } }]);
    await router.dispatch(mkReq({ mode: "elements", pattern: ".x" }));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(20);
    executeScript.mockClear();
    await router.dispatch(mkReq({ mode: "elements", pattern: ".x", dimensions: "geometry|font|pseudo", maxResults: 999 }));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(50);
  });
});

describe("mode=elements 维度自陈", () => {
  it("元素探针为每个命中项返回可追踪 selector", async () => {
    const { elementsProbeFunc } = await import("../src/handlers/query.js");
    document.body.innerHTML = `<main><button class="save">保存</button><button class="save">另存</button></main>`;

    const result = elementsProbeFunc("button.save", 10, ["geometry"], null, false) as {
      elements: Array<{ selector?: string }>;
    };

    expect(result.elements).toHaveLength(2);
    expect(result.elements.every((element) => typeof element.selector === "string")).toBe(true);
    expect(result.elements[0].selector).not.toBe(result.elements[1].selector);
  });

  it("命中项带 selector 时 handler 返回 query snapshotId", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      elements: [{ index: 0, tag: "button", selector: "main > button:nth-of-type(1)" }],
      total: 1,
      showing: 1,
      scanned: { elements: 3, shadowRoots: 0, iframes: 0 },
    } }]).mockResolvedValueOnce([{ result: { valid: true } }]);

    const res = await router.dispatch(mkReq({ mode: "elements", pattern: "button.save" }));
    const result = res.result as { snapshotId?: string; elements: Array<{ selector?: string }> };

    expect(result.snapshotId).toMatch(/^snap_/);
    expect(result.elements[0].selector).toBe("main > button:nth-of-type(1)");
  });

  it("缺少元素级 selector 时自陈 refs 不可用且不登记 snapshot", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      elements: [{ index: 0, tag: "button" }],
      total: 1,
      showing: 1,
      scanned: { elements: 1, shadowRoots: 0, iframes: 0 },
    } }]);

    const res = await router.dispatch(mkReq({ mode: "elements", pattern: "button" }));
    const result = res.result as { snapshotId?: string; refs?: { available: boolean; reason?: string } };

    expect(result.snapshotId).toBeUndefined();
    expect(result.refs).toEqual({
      available: false,
      reason: "element-level selectors unavailable; query refs were not registered",
    });
  });

  it("selector 唯一但身份不是原 query 目标时拒绝登记", async () => {
    executeScript
      .mockResolvedValueOnce([{ result: {
        elements: [{ index: 0, tag: "button", selector: "button:nth-of-type(1)" }],
        total: 1,
        showing: 1,
        scanned: { elements: 2, shadowRoots: 1, iframes: 0 },
      } }])
      .mockResolvedValueOnce([{ result: {
        valid: false,
        reason: "selector resolved to a different element",
      } }]);

    const res = await router.dispatch(mkReq({ mode: "elements", pattern: "button.shadow-target" }));
    const result = res.result as { snapshotId?: string; refs?: { available: boolean; reason?: string } };

    expect(result.snapshotId).toBeUndefined();
    expect(result.refs).toEqual({
      available: false,
      reason: "query refs were not registered: selector resolved to a different element",
    });
  });

  it("普通 light DOM 目标身份一致时仍登记 ref", async () => {
    document.body.innerHTML = `<main><button class="save">保存</button><button class="save">另存</button></main>`;
    let invocation = 0;
    executeScript.mockImplementation((details: { func: (...args: any[]) => unknown; args: unknown[] }) => {
      invocation++;
      if (invocation === 1) {
        return Promise.resolve([{ result: {
          elements: [{ index: 0, tag: "button", selector: "main > button:nth-of-type(1)" }],
          total: 1,
          showing: 1,
          scanned: { elements: 3, shadowRoots: 0, iframes: 0 },
        } }]);
      }
      return Promise.resolve([{ result: details.func(...details.args) }]);
    });

    const res = await router.dispatch(mkReq({ mode: "elements", pattern: "button.save" }));
    expect((res.result as { snapshotId?: string }).snapshotId).toMatch(/^snap_/);
  });

  it("P11 页面上的 light DOM 目标不因 shadow 同标签而误伤", async () => {
    document.body.innerHTML = `<button id="light-target">LIGHT</button><shadow-fixture></shadow-fixture>`;
    const host = document.querySelector("shadow-fixture")!;
    const root = host.attachShadow({ mode: "open" });
    const shadowButton = document.createElement("button");
    shadowButton.className = "shadow-target";
    root.append(shadowButton);
    let invocation = 0;
    executeScript.mockImplementation((details: { func: (...args: any[]) => unknown; args: unknown[] }) => {
      invocation++;
      if (invocation === 1) {
        return Promise.resolve([{ result: {
          elements: [{ index: 0, tag: "button", selector: "button:nth-of-type(1)" }],
          total: 1,
          showing: 1,
          scanned: { elements: 3, shadowRoots: 1, iframes: 0 },
        } }]);
      }
      return Promise.resolve([{ result: details.func(...details.args) }]);
    });

    const res = await router.dispatch(mkReq({ mode: "elements", pattern: "#light-target" }));
    expect((res.result as { snapshotId?: string }).snapshotId).toMatch(/^snap_/);
  });

  it("P11 shadow/light 构造经真实身份校验后不登记 ref", async () => {
    document.body.innerHTML = `<button id="light-target">LIGHT</button><shadow-fixture></shadow-fixture>`;
    const host = document.querySelector("shadow-fixture")!;
    const root = host.attachShadow({ mode: "open" });
    const shadowButton = document.createElement("button");
    shadowButton.className = "shadow-target";
    shadowButton.textContent = "SHADOW";
    root.append(shadowButton);
    let invocation = 0;
    executeScript.mockImplementation((details: { func: (...args: any[]) => unknown; args: unknown[] }) => {
      invocation++;
      if (invocation === 1) {
        return Promise.resolve([{ result: {
          elements: [{ index: 0, tag: "button", selector: "button:nth-of-type(1)" }],
          total: 1,
          showing: 1,
          scanned: { elements: 3, shadowRoots: 1, iframes: 0 },
        } }]);
      }
      return Promise.resolve([{ result: details.func(...details.args) }]);
    });

    const res = await router.dispatch(mkReq({ mode: "elements", pattern: "button.shadow-target" }));
    expect(res.result).toMatchObject({
      refs: {
        available: false,
        reason: 'query refs were not registered: selector "button:nth-of-type(1)" resolved to a different element',
      },
    });
  });

  it("DOM 重渲染后同一结构仍生成同一可追踪路径", async () => {
    const { elementsProbeFunc } = await import("../src/handlers/query.js");
    document.body.innerHTML = `<main><button class="save">第一次</button></main>`;
    const before = elementsProbeFunc("button.save", 1, ["geometry"], null, false) as {
      elements: Array<{ selector: string }>;
    };

    document.body.innerHTML = `<main><button class="save">重渲染后</button></main>`;
    const after = elementsProbeFunc("button.save", 1, ["geometry"], null, false) as {
      elements: Array<{ selector: string }>;
    };

    expect(after.elements[0].selector).toBe(before.elements[0].selector);
  });

  it("query snapshot 超过 60 秒后可由 GC 清除", async () => {
    vi.useFakeTimers();
    try {
      const capturedAt = new Date("2026-08-24T00:00:00.000Z");
      vi.setSystemTime(capturedAt);
      executeScript.mockResolvedValueOnce([{ result: {
        elements: [{ index: 0, tag: "button", selector: "main > button:nth-of-type(1)" }],
        total: 1,
        showing: 1,
        scanned: { elements: 1, shadowRoots: 0, iframes: 0 },
      } }]).mockResolvedValueOnce([{ result: { valid: true } }]);
      const res = await router.dispatch(mkReq({ mode: "elements", pattern: "button" }));
      const snapshotId = (res.result as { snapshotId: string }).snapshotId;
      expect(getSnapshotEntry(snapshotId)).toBeDefined();

      vi.advanceTimersByTime(60_001);
      gcSnapshots();
      expect(getSnapshotEntry(snapshotId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("请求了的维度标 available:true", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      elements: [{ index: 0, tag: "li", bbox: [0, 0, 1, 1], text: "A" }], total: 1, showing: 1,
      viewport: { w: 800, h: 600 }, scanned: { elements: 3, shadowRoots: 0, iframes: 0 },
    } }]);
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".x", dimensions: "geometry,text" }));
    const r = res.result as { dimensions: Record<string, { available: boolean }> };
    expect(r.dimensions.geometry.available).toBe(true);
    expect(r.dimensions.text.available).toBe(true);
  });

  it("font 维度 CDP 不可用时 available:false 并带 reason", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      elements: [{ index: 0, tag: "li", declaredFont: "Inter, sans-serif", fp: "LI:0" }], total: 1, showing: 1,
      scanned: { elements: 3, shadowRoots: 0, iframes: 0 },
    } }]);
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".x", dimensions: "font" }));
    const r = res.result as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.font.available).toBe(false);
    expect(typeof r.dimensions.font.reason).toBe("string");
    expect(r.dimensions.font.reason!.length).toBeGreaterThan(0);
  });

  it("truncated 在被截断时为 true 并保留真实 total", async () => {
    executeScript.mockResolvedValueOnce([{ result: { elements: [{ index: 0, tag: "li" }], total: 90, showing: 1, scanned: { elements: 100, shadowRoots: 0, iframes: 0 } } }]);
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".x", maxResults: 1 }));
    const r = res.result as { total: number; showing: number; truncated: boolean };
    expect(r.total).toBe(90);
    expect(r.showing).toBe(1);
    expect(r.truncated).toBe(true);
  });

  // 零命中会被 withDiagnosis 包成 {diagnosis, value},载荷不在顶层 —— 这是全仓的零命中约定,
  // 不是 elements 的特例。测试跟着约定走,顺便把"零命中必须自陈原因"一起锁住。
  it("零命中时所有维度标 available:false,不能让空结果看起来像体检合格", async () => {
    const { splitDiagnosis } = await import("@vortex-browser/shared");
    executeScript.mockResolvedValueOnce([{ result: { elements: [], total: 0, showing: 0, scanned: { elements: 9, shadowRoots: 0, iframes: 0 } } }]);
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".nope", dimensions: "geometry,text" }));
    const { value, diagnosis } = splitDiagnosis(res.result);
    expect(diagnosis).toBeTruthy();
    const r = value as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.geometry.available).toBe(false);
    expect(r.dimensions.text.available).toBe(false);
    expect(r.dimensions.geometry.reason).toMatch(/no elements/i);
  });

  it("全部元素某维度失败时该维度标 available:false", async () => {
    executeScript.mockResolvedValueOnce([{ result: { elements: [
      { index: 0, tag: "li", errors: { box: "style boom" } }, { index: 1, tag: "li", errors: { box: "style boom" } },
    ], total: 2, showing: 2, scanned: { elements: 9, shadowRoots: 0, iframes: 0 } } }]);
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".x", dimensions: "box" }));
    const r = res.result as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.box.available).toBe(false);
    expect(r.dimensions.box.reason).toMatch(/style boom/);
    expect(r.dimensions.box.reason).toMatch(/sampled/);
  });

  it("部分元素失败时维度仍可用,但 reason 说明失败比例", async () => {
    executeScript.mockResolvedValueOnce([{ result: { elements: [
      { index: 0, tag: "li", errors: { box: "boom" } }, { index: 1, tag: "li", box: {} },
    ], total: 2, showing: 2, scanned: { elements: 9, shadowRoots: 0, iframes: 0 } } }]);
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".x", dimensions: "box" }));
    const r = res.result as { dimensions: Record<string, { available: boolean; reason?: string }> };
    expect(r.dimensions.box.available).toBe(true);
    expect(r.dimensions.box.reason).toMatch(/1\/2/);
  });

  it("探针真实截断:命中 2 个、maxResults=1 时 total=2/showing=1", async () => {
    const { elementsProbeFunc } = await import("../src/handlers/query.js");
    document.body.innerHTML = `<i class="z"></i><i class="z"></i>`;
    const r = elementsProbeFunc(".z", 1, ["geometry"], null, false) as { total: number; showing: number; elements: unknown[] };
    expect(r.total).toBe(2);
    expect(r.showing).toBe(1);
    expect(r.elements).toHaveLength(1);
  });

  it("未截断时 truncated 为 false 而不是缺席", async () => {
    executeScript.mockResolvedValueOnce([{ result: { elements: [{ index: 0, tag: "li" }], total: 1, showing: 1, scanned: { elements: 3, shadowRoots: 0, iframes: 0 } } }]);
    const res = await router.dispatch(mkReq({ mode: "elements", pattern: ".x" }));
    expect((res.result as { truncated: boolean }).truncated).toBe(false);
  });
});
