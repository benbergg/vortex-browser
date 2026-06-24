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
        networkRequests: number; networkSample: string[]; clamped: boolean;
      }>;
    };
  }

  it("挂载 __vortexClickEffect(version=4, begin/end 函数)", async () => {
    const ns = await load();
    expect(ns.version).toBe(4);
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

  it("windowMs 语义=实际耗时：超 3000 钳到 3000 且 clamped=true；非法回退 300", async () => {
    const ns = await load();
    vi.useFakeTimers();
    try {
      const t1 = ns.begin("#b", 99999);
      const p1 = ns.end(t1);
      await vi.advanceTimersByTimeAsync(3000); // 无网络活动 → 等到 ceiling
      const e1 = await p1;
      expect(e1.windowMs).toBe(3000);
      expect(e1.clamped).toBe(true);

      const t2 = ns.begin("#b", -5 as unknown as number);
      const p2 = ns.end(t2);
      await vi.advanceTimersByTimeAsync(300); // 非法 → 默认 300 ceiling
      const e2 = await p2;
      expect(e2.windowMs).toBe(300);
      expect(e2.clamped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("晚到 POST（>1000ms）被自适应窗口捕获（#43 核心：旧固定 1000ms 会漏报 networkRequests:0）", async () => {
    const ns = await load();
    vi.useFakeTimers();
    // 受控 Resource Timing：POST 在 1500ms 才出现。perfStart=0。
    const entries: { name: string; initiatorType: string; startTime: number }[] = [];
    let clock = 0;
    vi.stubGlobal("performance", {
      now: () => clock,
      getEntriesByType: () => entries.slice(),
    });
    try {
      const t = ns.begin("#b", 3000); // ceiling 3000
      const p = ns.end(t);
      // 0~1450ms 无网络
      await vi.advanceTimersByTimeAsync(1450);
      clock = 1500;
      entries.push({ name: "https://api.bytenew.com/work/submit", initiatorType: "xmlhttprequest", startTime: 1500 });
      // 推进到 POST 后静默早返（1500 + IDLE_QUIET 400 + 轮询粒度）
      await vi.advanceTimersByTimeAsync(800);
      const eff = await p;
      expect(eff.networkRequests).toBe(1);
      expect(eff.networkSample).toEqual(["api.bytenew.com/work/submit"]);
      expect(eff.windowMs).toBeLessThan(3000); // 静默早返，未拖满 ceiling
      expect(eff.windowMs).toBeGreaterThanOrEqual(1500);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("网络活动后静默 IDLE_QUIET → 早返，不拖满 ceiling", async () => {
    const ns = await load();
    vi.useFakeTimers();
    const entries = [{ name: "https://api.bytenew.com/x", initiatorType: "fetch", startTime: 0 }];
    vi.stubGlobal("performance", { now: () => 0, getEntriesByType: () => entries.slice() });
    try {
      const t = ns.begin("#b", 3000);
      const p = ns.end(t);
      await vi.advanceTimersByTimeAsync(700); // 首 step 即见 1 个请求 → 之后静默 400 早返
      const eff = await p;
      expect(eff.networkRequests).toBe(1);
      expect(eff.windowMs).toBeLessThan(1000);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("全程无网络（静默失败 / isTrusted 拦截）→ 不早返，等到 ceiling，networkRequests:0 仍成立", async () => {
    const ns = await load();
    vi.useFakeTimers();
    vi.stubGlobal("performance", { now: () => 0, getEntriesByType: () => [] });
    try {
      const t = ns.begin("#b", 2000);
      const p = ns.end(t);
      await vi.advanceTimersByTimeAsync(2000);
      const eff = await p;
      expect(eff.networkRequests).toBe(0);
      expect(eff.windowMs).toBe(2000); // 等到 ceiling，未提前
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  // 视觉隐藏(sr-only / 屏幕阅读器 live-region announcer)的 role=alert/status 对用户零
  // 视觉呈现,不应计入 userFeedback。Next.js __next-route-announcer__(role=alert + clip
  // + 1×1)存在于每个 Next.js 页面,不滤会让每次 click 误报 userFeedback:"toast"
  // (2026-06-21 mantine.dev dogfood 实测:开/选 Select 两次点击均误报 toast)。
  // JSDOM 无布局,桩 checkVisibility + getBoundingClientRect 复刻 announcer 几何。
  describe("collectFeedback 不把 sr-only announcer 误判为 toast(Next.js route announcer 回归)", () => {
    function stubGeom(el: Element, w: number, h: number): void {
      (el as any).checkVisibility = () => true; // 非 display:none/visibility:hidden
      (el as any).getBoundingClientRect = () => ({
        width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {},
      });
    }

    it("sr-only role=alert(1×1 + clip,空文本) → toastHit 空, userFeedback != toast", async () => {
      const ns = await load();
      const ann = document.createElement("p");
      ann.setAttribute("role", "alert");
      ann.setAttribute("aria-live", "assertive");
      ann.style.position = "absolute";
      ann.style.overflow = "hidden";
      ann.style.clip = "rect(0px, 0px, 0px, 0px)";
      document.body.appendChild(ann);
      stubGeom(ann, 1, 1);
      const t = ns.begin("#b", 10);
      const eff = (await ns.end(t)) as any;
      expect(eff.toastHit).toEqual([]);
      expect(eff.userFeedback).not.toBe("toast");
    });

    it("真实可见 toast(.ant-message,多 px,有文本)仍被检测 → userFeedback=toast", async () => {
      const ns = await load();
      const toast = document.createElement("div");
      toast.className = "ant-message";
      toast.textContent = "操作成功";
      document.body.appendChild(toast);
      stubGeom(toast, 200, 40);
      const t = ns.begin("#b", 10);
      const eff = (await ns.end(t)) as any;
      expect(eff.toastHit).toContain(".ant-message");
      expect(eff.userFeedback).toBe("toast");
    });

    // 2026-06-22 Popover API dogfood:原生 popover 打开无 DOM mutation,:popover-open 归 dialog。
    it("打开的原生 popover(:popover-open) → dialogHit 含 :popover-open, userFeedback=dialog", async () => {
      const ns = await load();
      const pop = document.createElement("div");
      pop.setAttribute("popover", "");
      pop.textContent = "弹出层";
      document.body.appendChild(pop);
      stubGeom(pop, 200, 80);
      // jsdom 无真实 top-layer,桩 querySelectorAll 让 :popover-open 命中本节点(其余委托原实现)
      const orig = document.querySelectorAll.bind(document);
      (document as any).querySelectorAll = (sel: string) =>
        sel === ":popover-open" ? [pop] : orig(sel);
      try {
        const t = ns.begin("#b", 10);
        const eff = (await ns.end(t)) as any;
        expect(eff.dialogHit).toContain(":popover-open");
        expect(eff.userFeedback).toBe("dialog");
      } finally {
        (document as any).querySelectorAll = orig;
      }
    });

    it(":popover-open 抛 SyntaxError(浏览器不支持)不拖垮 toast 检测(逐选择器 guard)", async () => {
      const ns = await load();
      const toast = document.createElement("div");
      toast.className = "ant-message";
      toast.textContent = "已保存";
      document.body.appendChild(toast);
      stubGeom(toast, 200, 40);
      // 复刻不支持 Popover API 的浏览器::popover-open 抛 SyntaxError;其余委托原实现
      const orig = document.querySelectorAll.bind(document);
      (document as any).querySelectorAll = (sel: string) => {
        if (sel === ":popover-open") throw new SyntaxError("unsupported pseudo");
        return orig(sel);
      };
      try {
        const t = ns.begin("#b", 10);
        const eff = (await ns.end(t)) as any;
        // 守卫:单个选择器抛错被局部吞掉,toast 仍正确分类(旧单 try 会整批退化为 none)
        expect(eff.toastHit).toContain(".ant-message");
        expect(eff.userFeedback).toBe("toast");
      } finally {
        (document as any).querySelectorAll = orig;
      }
    });
  });

  // 裸 ARIA role 选择器([role='alert'] 等)语义上既被瞬态 toast 用,也被常驻正文内容块
  // 误用(文档站说明框 div.callout role=alert,760×106 完全可见、position:relative 在正常流)。
  // sr-only 尺寸滤拦不住这类大尺寸可见块 → 每次 click 误报 userFeedback:"toast"
  // (2026-06-22 shoelace.style/components/select dogfood 实测:开 sl-select 下拉误报 toast)。
  // 区分信号:真 toast 恒为定位浮层(自身或祖先 position fixed/absolute/sticky),文档内容块
  // 在正常流(static/relative)。仅对裸 role 选择器加定位门;框架专属 .class 选择器(bootstrap
  // .toast 自身常 static、容器才 fixed)不受此门约束,保持精确检测。
  describe("collectFeedback 裸 role 选择器要求定位浮层(in-flow role=alert 内容块回归 — shoelace callout)", () => {
    function stubGeom(el: Element, w: number, h: number): void {
      (el as any).checkVisibility = () => true;
      (el as any).getBoundingClientRect = () => ({
        width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {},
      });
    }

    it("in-flow role=alert 内容块(position:relative,正常流,大尺寸) → toastHit 空, userFeedback != toast", async () => {
      const ns = await load();
      const callout = document.createElement("div");
      callout.setAttribute("role", "alert");
      callout.style.position = "relative";
      callout.textContent = "This component works with standard forms";
      document.body.appendChild(callout);
      stubGeom(callout, 760, 106);
      const t = ns.begin("#b", 10);
      const eff = (await ns.end(t)) as any;
      expect(eff.toastHit).toEqual([]);
      expect(eff.userFeedback).not.toBe("toast");
    });

    it("定位浮层 role=alert(position:fixed) 真 toast → userFeedback=toast", async () => {
      const ns = await load();
      const toast = document.createElement("div");
      toast.setAttribute("role", "alert");
      toast.style.position = "fixed";
      toast.textContent = "已保存";
      document.body.appendChild(toast);
      stubGeom(toast, 200, 40);
      const t = ns.begin("#b", 10);
      const eff = (await ns.end(t)) as any;
      expect(eff.toastHit).toContain("[role='alert']");
      expect(eff.userFeedback).toBe("toast");
    });

    it("role=alert 自身 static 但祖先 position:fixed → 仍计为 toast(浮层容器内)", async () => {
      const ns = await load();
      const container = document.createElement("div");
      container.style.position = "fixed";
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = "提示";
      container.appendChild(alert);
      document.body.appendChild(container);
      stubGeom(alert, 180, 36);
      const t = ns.begin("#b", 10);
      const eff = (await ns.end(t)) as any;
      expect(eff.toastHit).toContain("[role='alert']");
      expect(eff.userFeedback).toBe("toast");
    });

    it("框架类选择器(.toast,position:static)不受定位门约束 → 仍检测为 toast", async () => {
      const ns = await load();
      const toast = document.createElement("div");
      toast.className = "toast"; // bootstrap toast item 自身常 static,容器才 fixed
      toast.textContent = "Bootstrap toast";
      document.body.appendChild(toast);
      stubGeom(toast, 250, 48);
      const t = ns.begin("#b", 10);
      const eff = (await ns.end(t)) as any;
      expect(eff.toastHit).toContain(".toast");
      expect(eff.userFeedback).toBe("toast");
    });
  });
});
