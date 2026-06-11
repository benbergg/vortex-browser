/**
 * Author: qingwa
 * Description: GAP-G(N0062) page-side 效果信号采集器 __vortexClickEffect.begin/end 纯函数测试。
 *   复刻注入语义:vi.resetModules() + 新 JSDOM 窗口让 IIFE 对干净 window 重跑(同 dom-resolve.test)。
 *   断言四信号(domMutations/urlChanged/focusChanged/ariaChanged)采集正确 + observed 降级。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

describe("click-effect page-side module (__vortexClickEffect)", () => {
  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><body><button id="b">OK</button><div id="d">x</div></body>');
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).MutationObserver = dom.window.MutationObserver;
  });

  async function load() {
    vi.resetModules();
    await import("../src/page-side/click-effect.js");
    return (window as any).__vortexClickEffect as {
      version: number;
      begin(sel: string, w: number): string;
      end(t: string): Promise<{
        domMutations: number; urlChanged: boolean; focusChanged: boolean;
        ariaChanged: boolean; observed: boolean; windowMs: number;
      }>;
    };
  }

  it("挂载 __vortexClickEffect(version=1, begin/end 函数)", async () => {
    const ns = await load();
    expect(ns.version).toBe(1);
    expect(typeof ns.begin).toBe("function");
    expect(typeof ns.end).toBe("function");
  });

  it("无任何变化 → domMutations=0, 全 false, observed=true", async () => {
    const ns = await load();
    const t = ns.begin("#b", 10);
    const eff = await ns.end(t);
    expect(eff.domMutations).toBe(0);
    expect(eff.urlChanged).toBe(false);
    expect(eff.focusChanged).toBe(false);
    expect(eff.ariaChanged).toBe(false);
    expect(eff.observed).toBe(true);
    expect(eff.windowMs).toBe(10);
  });

  it("窗口内新增 DOM 节点 → domMutations>0", async () => {
    const ns = await load();
    const t = ns.begin("#b", 20);
    const el = document.createElement("span");
    document.body.appendChild(el); // childList mutation
    const eff = await ns.end(t);
    expect(eff.domMutations).toBeGreaterThan(0);
  });

  it("target aria 变化 → ariaChanged=true", async () => {
    const ns = await load();
    const t = ns.begin("#b", 20);
    document.getElementById("b")!.setAttribute("aria-expanded", "true");
    const eff = await ns.end(t);
    expect(eff.ariaChanged).toBe(true);
  });

  it("activeElement 变化 → focusChanged=true", async () => {
    const ns = await load();
    const t = ns.begin("#b", 20);
    document.getElementById("b")!.focus();
    const eff = await ns.end(t);
    expect(eff.focusChanged).toBe(true);
  });

  it("未知 token(导航替换/超时清理) → observed=false", async () => {
    const ns = await load();
    const eff = await ns.end("nonexistent");
    expect(eff.observed).toBe(false);
    expect(eff.domMutations).toBe(0);
  });

  it("networkRequests:只计 perfStart 之后的 XHR/fetch/beacon, 忽略更早的与非 API 类型", async () => {
    const ns = await load();
    // 桩 performance:now 固定 1000(perfStart), getEntriesByType 返回受控 resource 条目
    vi.stubGlobal("performance", {
      now: () => 1000,
      getEntriesByType: () => [
        { name: "https://jd.com/old.js", initiatorType: "script", startTime: 500 }, // 早于 perfStart, 忽略
        { name: "https://api.jd.com/addCart?sku=1", initiatorType: "xmlhttprequest", startTime: 1100 }, // 计
        { name: "https://blackhole.m.jd.com/bypass", initiatorType: "fetch", startTime: 1200 }, // 计
        { name: "https://img.jd.com/a.png", initiatorType: "img", startTime: 1300 }, // 非 API, 忽略
        { name: "https://t.jd.com/track", initiatorType: "beacon", startTime: 1400 }, // 计
      ],
    });
    try {
      const t = ns.begin("#b", 10);
      const eff = await ns.end(t);
      expect(eff.networkRequests).toBe(3); // addCart + bypass + track
      expect(eff.networkSample).toEqual([
        "api.jd.com/addCart",
        "blackhole.m.jd.com/bypass",
        "t.jd.com/track",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("networkRequests:无业务请求(仅早期资源) → 0(京东风控 silent-fail 签名)", async () => {
    const ns = await load();
    vi.stubGlobal("performance", {
      now: () => 1000,
      getEntriesByType: () => [
        { name: "https://jd.com/old.js", initiatorType: "script", startTime: 500 },
      ],
    });
    try {
      const t = ns.begin("#b", 10);
      const eff = await ns.end(t);
      expect(eff.networkRequests).toBe(0);
      expect(eff.networkSample).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("networkSample 去重:高频重复埋点折叠, 腾出位给不同端点(京东 mercury 噪声场景)", async () => {
    const ns = await load();
    vi.stubGlobal("performance", {
      now: () => 1000,
      getEntriesByType: () => [
        { name: "https://mercury.jd.com/log.gif", initiatorType: "beacon", startTime: 1100 },
        { name: "https://mercury.jd.com/log.gif", initiatorType: "beacon", startTime: 1110 },
        { name: "https://mercury.jd.com/log.gif", initiatorType: "beacon", startTime: 1120 },
        { name: "https://mercury.jd.com/log.gif", initiatorType: "beacon", startTime: 1130 },
        { name: "https://blackhole.m.jd.com/bypass", initiatorType: "fetch", startTime: 1200 },
        { name: "https://api.m.jd.com/api", initiatorType: "xmlhttprequest", startTime: 1300 },
      ],
    });
    try {
      const t = ns.begin("#b", 10);
      const eff = await ns.end(t);
      expect(eff.networkRequests).toBe(6); // count 含重复
      // sample 去重 → 风控 + gateway 不再被 4× mercury 挤掉
      expect(eff.networkSample).toEqual([
        "mercury.jd.com/log.gif",
        "blackhole.m.jd.com/bypass",
        "api.m.jd.com/api",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("networkSample 最多 5 条", async () => {
    const ns = await load();
    const many = Array.from({ length: 8 }, (_, i) => ({
      name: `https://h${i}.com/p`,
      initiatorType: "fetch",
      startTime: 1100 + i,
    }));
    vi.stubGlobal("performance", { now: () => 1000, getEntriesByType: () => many });
    try {
      const t = ns.begin("#b", 10);
      const eff = await ns.end(t);
      expect(eff.networkRequests).toBe(8);
      expect(eff.networkSample.length).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("performance 不可用 → networkRequests=0, networkSample=[](降级不崩)", async () => {
    const ns = await load();
    vi.stubGlobal("performance", undefined);
    try {
      const t = ns.begin("#b", 10);
      const eff = await ns.end(t);
      expect(eff.networkRequests).toBe(0);
      expect(eff.networkSample).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("windowMs 钳制:超 1000 截到 1000, 负数/非法回退 300", async () => {
    const ns = await load();
    vi.useFakeTimers();
    try {
      const t1 = ns.begin("#b", 99999);
      const p1 = ns.end(t1);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await p1).windowMs).toBe(1000);

      const t2 = ns.begin("#b", -5 as unknown as number);
      const p2 = ns.end(t2);
      await vi.advanceTimersByTimeAsync(300);
      expect((await p2).windowMs).toBe(300);
    } finally {
      vi.useRealTimers();
    }
  });
});
