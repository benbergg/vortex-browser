// @vitest-environment jsdom
// 组合模式的 handler 层行为:维度校验、上限、维度自陈。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerQueryHandlers } from "../src/handlers/query.js";

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
