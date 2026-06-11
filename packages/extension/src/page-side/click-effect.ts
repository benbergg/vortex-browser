// Page-side module：CLICK 效果信号采集器，暴露给 dom.ts 合成路径 inline func 与
// cdp.ts useRealMouse 路径共用（GAP-G，N0062 评测）。
//
// 背景：CLICK 是唯一无副作用信号的 act 原语——dom.ts / cdp.ts 派发后无条件
// return success:true，京东加购被风控（isTrusted 检测）静默拦下时 vortex 仍报成功。
// 本模块在 click 派发前后采集**非判定性**证据（DOM mutation 计数 / url / focus / aria
// 变化），让上层 agent 自己判断是否 silent failure——success 恒 true，不翻转（否则
// 误伤 target=_blank / 异步 / 导航 / 别处 toast，详见知识库 N0062 核实订正附录 §4）。
//
// 不对称解读：domMutations=0 且 url/focus/aria 全 false = 强阴性（点击很可能未生效）；
// 高 domMutations = 弱阳性（SPA 噪声页偏高，不等于生效）。MutationObserver 只在 begin
// 后 observe → 天然只计 click 之后的新增 mutation，无需排除点击前历史。
//
// 两路单一真源（防族H 漂移）：合成路径与 CDP 路径都经 window.__vortexClickEffect
// 调用，禁止任一路 inline 复制本逻辑。由 loadPageSideModule(tid, frameId, "click-effect")
// 预注入（同 MAIN world，与 __vortexDomResolve 可见）。命名空间 + version 守卫。

/** CLICK 效果信号（非判定性证据，success 不因此翻转）。 */
export interface ClickEffect {
  /** click 派发后 windowMs 窗口内 document 级 mutation 计数（childList+subtree+attributes）。
   *  0 且其余信号皆 false 强烈提示点击可能未生效；高值≠生效（SPA 噪声）。 */
  domMutations: number;
  /** location.href 在窗口内是否变化（SPA 路由 / 导航）。 */
  urlChanged: boolean;
  /** document.activeElement 是否变化（打开 input/dialog 常伴随）。 */
  focusChanged: boolean;
  /** 目标元素 aria-expanded/-pressed/-checked/-selected/class 是否变化（toggle/disclosure 强信号）。 */
  ariaChanged: boolean;
  /** click 派发后窗口内页面发起的 XHR/fetch/beacon 请求数（Resource Timing）。
   *  0 = 点击未触发任何业务请求（强 silent-fail 信号，如京东风控拦在 addCart 之前）。 */
  networkRequests: number;
  /** 上述请求前 5 个的 host+path（截断），供 agent 辨识业务端点 vs 风控/埋点接口。
   *  例：京东加购被风控时此处仅见 blackhole.m.jd.com/bypass，无 addCart 端点 → silent fail。 */
  networkSample: string[];
  /** 采集是否成功完成（false=document 被导航替换 / token 已超时清理，信号不可信）。 */
  observed: boolean;
  /** 实际等待窗口（ms）。 */
  windowMs: number;
}

interface PendingEntry {
  observer: MutationObserver;
  count: number;
  url: string;
  active: Element | null;
  target: Element | null;
  aria: string;
  // Resource Timing 起点：end 只统计 startTime >= perfStart 的请求（即 click 之后发起的）。
  // NaN 表示 performance API 不可用（采集降级，networkRequests 留 0）。
  perfStart: number;
  windowMs: number;
  timer: ReturnType<typeof setTimeout>;
}

(function () {
  if ((window as unknown as { __vortexClickEffect?: { version?: number } }).__vortexClickEffect?.version === 1) {
    return;
  }

  const PENDING: Record<string, PendingEntry> = {};
  let seq = 0;

  // begin 后无 end（异常 / 调用方崩）则强制 disconnect，防 observer 悬挂泄漏。
  const PENDING_TTL_MS = 5000;
  const WINDOW_MAX_MS = 1000;
  const WINDOW_DEFAULT_MS = 300;

  const ariaFingerprint = (el: Element | null): string => {
    if (!el) return "";
    try {
      return [
        el.getAttribute("aria-expanded") ?? "",
        el.getAttribute("aria-pressed") ?? "",
        el.getAttribute("aria-checked") ?? "",
        el.getAttribute("aria-selected") ?? "",
        typeof el.className === "string" ? el.className : "",
      ].join("|");
    } catch {
      return "";
    }
  };

  // 优先经 __vortexDomResolve 穿 open shadow 解析 target（与门一致），未就绪回退 light DOM。
  const resolveTarget = (sel: string): Element | null => {
    try {
      const r = (window as unknown as { __vortexDomResolve?: { queryDeep?: (s: string) => Element | null } })
        .__vortexDomResolve;
      if (r?.queryDeep) return r.queryDeep(sel);
      return document.querySelector(sel);
    } catch {
      return null;
    }
  };

  const clampWindow = (w: unknown): number =>
    typeof w === "number" && isFinite(w) && w >= 0 ? Math.min(w, WINDOW_MAX_MS) : WINDOW_DEFAULT_MS;

  const NET_SAMPLE_MAX = 5;
  const NET_URL_MAX = 80;

  // 经 Resource Timing(performance.getEntriesByType('resource'))统计 perfStart 之后发起的
  // XHR/fetch/beacon 请求——纯 page-side, 无需 CDP debugger, 合成/CDP 两路皆可用。
  // 跨源无 TAO 的资源仍有 name(URL)+initiatorType, 足够辨识端点(timing 被遮无所谓)。
  const collectNetwork = (perfStart: number): { networkRequests: number; networkSample: string[] } => {
    // sample 去重(host+path):埋点 beacon 常高频重复(京东 mercury/log.gif ×N),不去重会挤掉
    // 风控/业务端点。去重后 agent 看到的是「命中的不同端点集合」,更易辨识 silent-fail——
    // 例:{mercury/log.gif, h5speed/event/log, api.m.jd.com/api, blackhole/bypass} 一眼看出
    // 只有埋点+风控、无加购成功端点。count 仍是总请求数(含重复)。
    const seen = new Set<string>();
    const sample: string[] = [];
    let count = 0;
    try {
      if (
        typeof performance === "undefined" ||
        typeof performance.getEntriesByType !== "function" ||
        !isFinite(perfStart)
      ) {
        return { networkRequests: 0, networkSample: sample };
      }
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      for (const e of entries) {
        if (e.startTime < perfStart) continue;
        const it = e.initiatorType;
        if (it !== "xmlhttprequest" && it !== "fetch" && it !== "beacon") continue;
        count++;
        let label: string;
        try {
          const u = new URL(e.name);
          label = (u.host + u.pathname).slice(0, NET_URL_MAX);
        } catch {
          label = String(e.name).slice(0, NET_URL_MAX);
        }
        if (sample.length < NET_SAMPLE_MAX && !seen.has(label)) {
          seen.add(label);
          sample.push(label);
        }
      }
    } catch {
      return { networkRequests: count, networkSample: sample };
    }
    return { networkRequests: count, networkSample: sample };
  };

  (window as unknown as { __vortexClickEffect: unknown }).__vortexClickEffect = {
    version: 1,

    /** 派发前调用：snapshot（url/activeElement/target aria）+ 启动 document 根 observer。返回 token。 */
    begin(sel: string, windowMs: number): string {
      const token = "ce" + ++seq;
      const entry: PendingEntry = {
        observer: new MutationObserver((muts) => {
          entry.count += muts.length;
        }),
        count: 0,
        url: window.location.href,
        active: document.activeElement,
        target: resolveTarget(sel),
        aria: "",
        perfStart: (() => {
          try {
            return typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : NaN;
          } catch {
            return NaN;
          }
        })(),
        windowMs: clampWindow(windowMs),
        timer: setTimeout(() => {
          try {
            entry.observer.disconnect();
          } catch {
            /* ignore */
          }
          delete PENDING[token];
        }, PENDING_TTL_MS),
      };
      entry.aria = ariaFingerprint(entry.target);
      try {
        entry.observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      } catch {
        /* document 不可观察（极少）→ count 留 0 */
      }
      PENDING[token] = entry;
      return token;
    },

    /** 派发后调用：await windowMs → diff snapshot + 读 observer 计数 + disconnect。返回 ClickEffect。 */
    end(token: string): Promise<ClickEffect> {
      const entry = PENDING[token];
      if (!entry) {
        // token 丢失（导航替换 document / 超时清理 / helper 在新 document 重注入）→ observed:false。
        return Promise.resolve({
          domMutations: 0,
          urlChanged: false,
          focusChanged: false,
          ariaChanged: false,
          networkRequests: 0,
          networkSample: [],
          observed: false,
          windowMs: 0,
        });
      }
      return new Promise<ClickEffect>((resolve) => {
        setTimeout(() => {
          clearTimeout(entry.timer);
          try {
            entry.observer.disconnect();
          } catch {
            /* ignore */
          }
          delete PENDING[token];
          let urlChanged = false;
          let focusChanged = false;
          let ariaChanged = false;
          let observed = true;
          try {
            urlChanged = window.location.href !== entry.url;
            focusChanged = document.activeElement !== entry.active;
            // target 仍在文档内才比对 aria；被 re-render 摘除则 aria 不可信但 observer 计数仍有效。
            if (entry.target && entry.target.isConnected) {
              ariaChanged = ariaFingerprint(entry.target) !== entry.aria;
            }
          } catch {
            observed = false;
          }
          const net = collectNetwork(entry.perfStart);
          resolve({
            domMutations: entry.count,
            urlChanged,
            focusChanged,
            ariaChanged,
            networkRequests: net.networkRequests,
            networkSample: net.networkSample,
            observed,
            windowMs: entry.windowMs,
          });
        }, entry.windowMs);
      });
    },
  };
})();

export {};
