/**
 * Author: qingwa
 * Description: N0041 — click-effect hidden-tab background-throttle 修复测试。
 *   背景:hidden tab 中 Chrome timer-throttle 把 end() 的 setTimeout(step,150) 轮询拖到秒级,
 *   导致 end() 阻塞数秒~数十秒(实测 16s)。变体3:end() 按 document.visibilityState 分流——
 *   visible 路径 setTimeout 轮询不变,hidden 路径走 MessageChannel + performance.now busy-poll,
 *   不被 background-throttle。并新增 effect.tabHidden 让 agent 感知 throttle 风险。
 *   复刻注入语义:vi.resetModules() + 新 JSDOM 窗口让 IIFE 对干净 window 重跑(同 helper.test)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";

describe("click-effect hidden-tab 分支 (N0041 background-throttle 修复)", () => {
  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><body><button id="b">OK</button></body>');
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).MutationObserver = dom.window.MutationObserver;
    // performance:保留真实 now(供 hidden 分支 busy-poll 真实推进),getEntriesByType 置空(无网络噪声)。
    const realNow = (globalThis.performance?.now ?? (() => 0)).bind(globalThis.performance);
    vi.stubGlobal("performance", { now: realNow, getEntriesByType: () => [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function load() {
    vi.resetModules();
    await import("../src/page-side/click-effect.js");
    return (window as any).__vortexClickEffect as {
      version: number;
      begin(sel: string, w: number): string;
      end(t: string): Promise<{
        domMutations: number; observed: boolean; windowMs: number;
        userFeedback: string; tabHidden: boolean;
      }>;
    };
  }

  function setVisibility(v: "visible" | "hidden"): void {
    Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
    Object.defineProperty(document, "hidden", { value: v === "hidden", configurable: true });
  }

  it("visible tab: tabHidden=false", async () => {
    const ns = await load();
    setVisibility("visible");
    const t = ns.begin("#b", 10);
    const eff = await ns.end(t);
    expect(eff.tabHidden).toBe(false);
    expect(eff.observed).toBe(true);
  });

  it("hidden tab: tabHidden=true 且信号正确采集(domMutations>0, observed=true)", async () => {
    const ns = await load();
    setVisibility("hidden");
    const t = ns.begin("#b", 30);
    document.body.appendChild(document.createElement("span")); // childList mutation
    const eff = await ns.end(t);
    expect(eff.tabHidden).toBe(true);
    expect(eff.observed).toBe(true);
    expect(eff.domMutations).toBeGreaterThan(0);
  });

  it("hidden tab + setTimeout 被 throttle: end() 经 MessageChannel 仍在 ceiling 内返回(不阻塞)", async () => {
    const ns = await load();
    setVisibility("hidden");
    // 模拟 Chrome background throttle:≥50ms 的 setTimeout 永不触发(返回伪 id)。
    // 若 hidden 分支错误依赖 setTimeout 轮询 → end() 永不 resolve → 测试超时(红)。
    // 正确实现走 MessageChannel + performance.now → 不受影响(绿)。
    const realST = globalThis.setTimeout;
    const patched = ((fn: (...a: unknown[]) => void, delay?: number, ...a: unknown[]) =>
      typeof delay === "number" && delay >= 50
        ? (0 as unknown as ReturnType<typeof setTimeout>)
        : realST(fn, delay, ...a)) as typeof setTimeout;
    globalThis.setTimeout = patched;
    (window as unknown as { setTimeout: typeof setTimeout }).setTimeout = patched;
    try {
      const t = ns.begin("#b", 100);
      document.body.appendChild(document.createElement("span"));
      const eff = await ns.end(t);
      expect(eff.tabHidden).toBe(true);
      expect(eff.observed).toBe(true);
      expect(eff.domMutations).toBeGreaterThan(0);
      // windowMs(elapsed)应推进到 ~ceiling(100),证明 busy-poll 跑满窗口而非提前/卡死。
      expect(eff.windowMs).toBeGreaterThanOrEqual(100);
    } finally {
      globalThis.setTimeout = realST;
      (window as unknown as { setTimeout: typeof setTimeout }).setTimeout = realST;
    }
  }, 3000);

  it("hidden tab + MessageChannel 不可用: 降级回 setTimeout 轮询(不崩,仍采集信号)", async () => {
    const ns = await load();
    setVisibility("hidden");
    vi.stubGlobal("MessageChannel", undefined); // 极旧环境:无 MessageChannel
    vi.useFakeTimers();
    try {
      const t = ns.begin("#b", 100);
      document.body.appendChild(document.createElement("span"));
      const p = ns.end(t);
      await vi.advanceTimersByTimeAsync(100); // 降级走 setTimeout，fake timer 推进
      const eff = await p;
      expect(eff.observed).toBe(true);
      expect(eff.tabHidden).toBe(true);
      expect(eff.domMutations).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("token 丢失分支也带 tabHidden 字段", async () => {
    const ns = await load();
    setVisibility("hidden");
    const eff = await ns.end("nonexistent");
    expect(eff.observed).toBe(false);
    expect(eff.tabHidden).toBe(true);
  });

  it("version bump 到 4(新增 tabHidden 字段,签名变化)", async () => {
    const ns = await load();
    expect(ns.version).toBe(4);
  });
});
