// 事件隔离（suite B）：前台的 idle 判定**不能**被后台 tab 的请求拖住。
//
// 契约（Task 4 重建后的三条断言）：
//   B1  **无跨 tab 泄漏**：前台 tab 的 network 日志里没有后台的 /slow 条目
//   B2  **前台没被拖住**：前台 idle 判定返回，且耗时 ≪ SLOW_MS
//   B3′ **负向验证**：删掉扩展里 awaitIdle 的 tab 过滤 ⇒ 本用例必须红（恢复后转绿）
//
// ── 为什么必须重建判别力（Task 1 之后）──────────────────────────────────
// Task 1 把 network idle 改成了**静默期**语义：idle = 「最后一次匹配请求后连续
// idleTime 内没有新的匹配请求」，**挂着的请求不再阻断 idle**。于是旧断言全部变成
// **恒真**（假绿）：
//   · 前台的 network 日志由 packages/extension/src/handlers/network.ts **按 tab 独立
//     维护**（apiLogs 以 tabId 为键），**不经** awaitIdle 的 tab 过滤 ⇒ 删掉过滤也
//     不会让前台的日志里出现后台的 /slow；
//   · **单个**后台慢请求只重置**一次**静默计时 ⇒ 前台照样在 ~idleTime 后 idle。
// ⇒ 判别力只能从「后台**持续**发请求」里拿：静默计时器随每个新的匹配请求**重启**
//   （Task 1 的要害），后台请求源源不断 ⇒ 前台的静默期被不断推后 ⇒ 前台永远等不到
//   idle ⇒ 用例红。这正是 B3′ 要放大出来的东西。
//
// ── 时序（错一步就是假绿）────────────────────────────────────────────────
//   ⓪ **先记下前台 tab 是哪个**（在建后台 tab 之前）
//      —— hub 的 tab.create 会把 session 的当前 tab 切到新建的 tab
//      （packages/hub/src/router.ts 的 updateTabState → claimTab(makeCurrent=true)），
//      所以「不带 tabId 的调用」在建完后台 tab 之后会落到**后台** tab 上：
//      那样测的就不是「前台 idle 不被后台拖住」，而是「后台自己不被自己拖住」。
//      办法：建后台 tab 之前先问清楚前台 tab 是哪个，之后所有前台调用都**显式带上它**。
//   ① 后台 tab 建好、文档加载完成
//      —— fixture 首页嵌的是**跨源 iframe**（http://localhost:<port>/child vs 首页的
//      http://127.0.0.1:<port>/）：这是旧缺陷的现场，**必须保留**（fixture 不动）。
//   ② **后台网络监听先启用**（debug_read → network 订阅 → CDP Network 域 enable）
//      —— 不开的话后台请求根本不产生 CDP 事件，测的就不是"隔离"而是"没监听"
//   ③ **前台也先把 Network 域打开**（同上）—— awaitIdle 里那句 enableDomain
//      于是变成同步空操作，监听器在同一个 tick 内注册完；否则「监听注册」与
//      「后台请求发出」是竞态，用例可能整段落空（又是一个假绿窗口）。
//   ④ 记下前台开监听前的时刻 t0（页面时钟 = 浏览器时钟）
//   ⑤ **前台开始 idle 监听**（不 await）
//   ⑥ 前台发一个探针请求 ⇒ 证明监听器确实已经武装（matchedRequests ≥ 1）
//   ⑦ **后台慢请求**（/slow?ms=6000，页面里记下发起时刻）
//      **+ 后台持续发请求**（间隔 < idleTime，持续到前台 idle 返回为止）
//      —— 持续发请求是 B3′ 的放大器：静默期会被不断推后
//   ⑧ 等前台 idle 判定返回 ⇒ 跑 B1 / B2 / 前提校验
//
// 时刻口径：发起时刻取**页面时钟**（浏览器进程），idle 判定时刻用
// 「前台页面在开监听前记下的时刻 + 扩展回传的 waitedMs」—— 三者同一台浏览器、
// 同一时钟，且后者是判定时刻的**下界**（扩展的计时起点晚于页面记录时刻），
// 于是判定更严格而不是更宽松。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, extractEvalJson } from "../_helpers.js";

/** 后台慢请求的时长（fixture 的 /slow?ms=N 会延迟 N ms 才响应）。 */
const SLOW_MS = 6000;
/**
 * 前台 idle 的超时。**必须 < SLOW_MS**：否则即使没有隔离，
 * 超时也会晚于慢请求结束才触发 → 用例照样"通过"（假绿）。
 */
const IDLE_TIMEOUT_MS = 4000;
/**
 * 后台「持续发请求」的间隔（ms）。
 *
 * **必须 < 扩展的 idleTime**（network idle 默认 500ms）：静默期语义下，静默计时器
 * 随每个新的匹配请求**重启**。后台请求间隔只要小于 idleTime，前台的静默期就一直
 * 被推后 ⇒ 前台永远判不出 idle（负向验证的放大器）。
 * 反过来，间隔 ≥ idleTime 时两次请求之间静默期会到期 ⇒ 前台照样 idle ⇒ 又是假绿。
 */
const BG_BURST_INTERVAL_MS = 120;
/**
 * 后台持续请求的**响应**时长（短）。只有**请求发起时刻**影响静默期，响应快慢无关；
 * 取短值是为了让这些请求很快进网络日志（B1 的阳性对照要用它们）。
 */
const BG_BURST_URL_MS = 100;
/** 后台持续请求的次数上限（安全网：前台 idle 最多等 IDLE_TIMEOUT_MS）。 */
const BG_BURST_MAX = 60;
/** 前提不成立时的重试次数（环境抖动不该直接判死）。 */
const MAX_ATTEMPTS = 3;
/** 等后台 tab 文档加载完成的时限。 */
const BG_LOAD_TIMEOUT_MS = 10000;

/** 页面里回读的慢请求状态。 */
interface SlowRequestState {
  /** 慢请求的发起时刻（页面时钟 = 浏览器时钟）。 */
  start: number | null;
  /** 回读时刻。 */
  now: number;
}

/** 从工具返回文本里抠出 JSON 对象（自陈块会拼在后面，故不能直接 parse 全文）。 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 等一会儿（毫秒）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 网络日志条目（扩展 NetworkEntry 的关键字段）。 */
interface LogEntry {
  url?: string;
  /** CDP 记的条目 method 非空；Resource Timing 回填的条目 method 为空。 */
  method?: string;
  /** 请求发起时刻（epoch ms）。CDP 与 Resource Timing 回填的条目都有。 */
  startTime?: number;
}

/**
 * 从工具返回文本里抠出日志条目数组。
 *
 * 两种形态都要认：非空时是裸数组 `[{...}]`；空时是自陈信封
 * `{"__vortexDiagnosis":"...","value":[]}`。
 */
function parseLogEntries(text: string): LogEntry[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed as LogEntry[];
    } catch {
      // 落到下面按对象解析
    }
  }
  const obj = parseJsonObject(text);
  const value = obj?.value;
  return Array.isArray(value) ? (value as LogEntry[]) : [];
}

/** 挑出 URL 里带 /slow 的条目（B1 的判定对象）。 */
function slowEntries(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => typeof e.url === "string" && e.url.includes("/slow"));
}

/** 等后台 tab 的文档加载完成（tab.status 说文档，不说页面里的 fetch）。 */
async function waitForTabLoaded(
  ctx: { call: (name: string, args: Record<string, unknown>) => Promise<unknown> },
  tabId: number,
): Promise<boolean> {
  const deadline = Date.now() + BG_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tabs = parseTabList(extractText(await ctx.call("vortex_tab_list", {})));
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** tab.list 里的一个 tab（本用例用得到的字段）。 */
interface TabInfo {
  id?: number;
  status?: string;
  /** 浏览器侧：这个 tab 是不是所在窗口的 active tab。 */
  active?: boolean;
  /** 浏览器侧：所在窗口是不是聚焦窗口。 */
  lastFocused?: boolean;
  /** hub 标注：这个 tab 是不是该 session 的当前 tab（不带 tabId 的请求就落到它上面）。 */
  current?: boolean;
}

/**
 * 解析 tab.list 的返回（数组形态；多浏览器时 hub 会包成 {tabs:[...]}）。
 */
function parseTabList(text: string): TabInfo[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed as TabInfo[];
    } catch {
      // 落到下面按对象解析
    }
  }
  const obj = parseJsonObject(text);
  const tabs = obj?.tabs;
  return Array.isArray(tabs) ? (tabs as TabInfo[]) : [];
}

/**
 * 找出「前台 tab」：不带 tabId 的请求真正会落到的那个 tab。
 *
 * 口径与 hub 一致：hub 给 session 的当前 tab 打 `current: true` 标注，
 * 不带 tabId 的请求就路由到它。取不到再退回浏览器侧的 active tab
 * （扩展解析 active tab 的口径是 `active && 聚焦窗口`）。
 */
function pickForegroundTab(tabs: TabInfo[]): number | null {
  const current = tabs.find((t) => t.current === true && typeof t.id === "number");
  if (current) return current.id as number;
  const active =
    tabs.find((t) => t.active === true && t.lastFocused === true && typeof t.id === "number") ??
    tabs.find((t) => t.active === true && typeof t.id === "number");
  return active ? (active.id as number) : null;
}

const def: CaseDefinition = {
  name: "contract/event-isolation",
  suite: "b",
  async run(ctx) {
    let lastReason = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      lastReason = "";
      let bgTabId: number | null = null;
      /** 后台持续请求的在途 promise（收尾时排空，避免 tab 关掉后还在飞）。 */
      const pendingBurst: Promise<unknown>[] = [];
      try {
        // ── ⓪ 先记下前台 tab（必须在建后台 tab **之前**）──────────────────────
        // 建后台 tab 会把 session 的当前 tab 切过去（hub 的 tab.create → claimTab），
        // 之后不带 tabId 的调用全落到后台 tab 上 —— 测的就不是「前台不被后台拖住」了。
        const fgTabId = pickForegroundTab(parseTabList(extractText(await ctx.call("vortex_tab_list", {}))));
        if (fgTabId == null) {
          lastReason = "找不到前台 tab（tab.list 里既没有 session 当前 tab，也没有 active tab）";
          continue;
        }

        // ── ① 后台 tab（不激活，前台 tab 保持 active）────────────────────────
        const created = extractText(
          await ctx.call("vortex_tab_create", { url: `${ctx.baseUrl}/`, active: false }),
        );
        const createdJson = parseJsonObject(created) ?? {};
        if (typeof createdJson.id !== "number") {
          lastReason = `后台 tab 创建失败：${created.slice(0, 200)}`;
          continue;
        }
        bgTabId = createdJson.id;

        if (!(await waitForTabLoaded(ctx, bgTabId))) {
          lastReason = `后台 tab 未在 ${BG_LOAD_TIMEOUT_MS}ms 内加载完成`;
          continue;
        }

        // ── ② 后台网络监听先启用 ────────────────────────────────────────────
        // debug_read(source=network) 会 ensureSubscribed → CDP Network.enable，
        // 之后后台 tab 的请求才会产生 requestWillBeSent 事件。
        const bgSubscribe = extractText(
          await ctx.call("vortex_debug_read", {
            source: "network",
            pattern: "slow",
            tabId: bgTabId,
          }),
        );
        ctx.assert(
          !/Error \[/.test(bgSubscribe),
          `后台网络订阅调用不应报错，实际: ${bgSubscribe.slice(0, 200)}`,
        );

        // ── ②' 后台订阅探针：发一个快请求，确认它真的进了 CDP 网络日志 ──────
        // 光「调用没报错」不够：订阅没生效的话后台请求压根不产生 CDP 事件，
        // 本用例就整段落空（假绿）。探针的日志条目必须有 method（CDP 记的）——
        // Resource Timing 回填的条目 method 是空的，靠这个区分二者。
        const bgProbeToken = "vortex-bg-probe";
        await ctx.call("vortex_evaluate", {
          tabId: bgTabId,
          code: `(function(){
            try {
              window.fetch(${JSON.stringify(`${ctx.baseUrl}/child?${bgProbeToken}=1`)}).catch(function(){});
              return "probe";
            } catch (e) {
              return "failed";
            }
          })()`,
        });
        let subscribed = false;
        for (let i = 0; i < 30 && !subscribed; i++) {
          const entries = parseLogEntries(
            extractText(
              await ctx.call("vortex_debug_read", {
                source: "network",
                pattern: bgProbeToken,
                tabId: bgTabId,
              }),
            ),
          );
          subscribed = entries.some((e) => typeof e.method === "string" && e.method.length > 0);
          if (!subscribed) await sleep(100);
        }
        if (!subscribed) {
          lastReason = "后台 tab 的 CDP 网络订阅未生效（探针请求没进网络日志）";
          continue;
        }

        // ── ③ 前台也先把 Network 域打开 ─────────────────────────────────────
        // awaitIdle 里那句 enableDomain 于是变成同步空操作：监听器在同一个 tick
        // 内注册完，不会和「后台慢请求发出」抢先后（抢输了就等于没测）。
        const fgSubscribe = extractText(
          await ctx.call("vortex_debug_read", { source: "network", pattern: "slow", tabId: fgTabId }),
        );
        ctx.assert(
          !/Error \[/.test(fgSubscribe),
          `前台网络订阅调用不应报错，实际: ${fgSubscribe.slice(0, 200)}`,
        );

        // ── ④ 前台页面记下开监听前的时刻（浏览器时钟，与慢请求发起时刻同轴）──
        const t0 = extractEvalJson<number>(
          await ctx.call("vortex_evaluate", {
            tabId: fgTabId,
            code: `return Date.now();`,
          }),
        );

        // ── ⑤ 前台开始 idle 监听（不 await！）────────────────────────────────
        const idleIssuedAt = Date.now();
        const idlePromise = ctx.call("vortex_wait_for", {
          mode: "idle",
          value: "network",
          timeout: IDLE_TIMEOUT_MS,
          tabId: fgTabId,
        });
        // 持续发请求的循环靠这个标记退出（「持续到前台 idle 返回为止」）。
        let idleSettled = false;
        void idlePromise.then(
          () => {
            idleSettled = true;
          },
          () => {
            idleSettled = true;
          },
        );

        // ── ⑥ 前台探针：证明监听器确实已经武装 ───────────────────────────────
        // 探针走前台（会被计入 matchedRequests）；两条 evaluate 按序发出 ⇒ 探针的
        // requestWillBeSent 一定早于后台慢请求的。
        const probeUrl = `${ctx.baseUrl}/child`;
        await ctx.call("vortex_evaluate", {
          tabId: fgTabId,
          code: `(function(){
            window.fetch(${JSON.stringify(probeUrl)}).catch(function(){});
            return "probe";
          })()`,
        });

        // ── ⑦ 后台慢请求 ────────────────────────────────────────────────────
        const slowUrl = `${ctx.baseUrl}/slow?ms=${SLOW_MS}`;
        const issued = extractText(
          await ctx.call("vortex_evaluate", {
            tabId: bgTabId,
            code: `(function(){
              try {
                window.__vortexSlowStart = Date.now();
                window.fetch(${JSON.stringify(slowUrl)}).catch(function(){});
                return "issued";
              } catch (e) {
                return "failed:" + String(e);
              }
            })()`,
          }),
        );
        if (!issued.includes("issued")) {
          lastReason = `后台慢请求未发出：${issued.slice(0, 200)}`;
          continue;
        }

        // ── ⑦' 后台**持续**发请求（B3′ 的放大器）────────────────────────────
        // 单个慢请求只重置一次静默计时 ⇒ 前台照样 idle（假绿）。必须让后台**源源不断**
        // 地发请求（间隔 < idleTime），静默计时器才会被不断推后 ⇒ 前台等不到 idle。
        // 不 await 每次调用：调度节奏由本地的间隔决定，不受 MCP 往返时延影响。
        const burstUrl = `${ctx.baseUrl}/slow?ms=${BG_BURST_URL_MS}`;
        const burstCode = `(function(){
          try {
            window.fetch(${JSON.stringify(burstUrl)}).catch(function(){});
            return "burst";
          } catch (e) {
            return "failed";
          }
        })()`;
        let burstCount = 0;
        let burstInFlight = 0;
        while (!idleSettled && burstCount < BG_BURST_MAX) {
          if (burstInFlight < 4) {
            burstInFlight++;
            burstCount++;
            pendingBurst.push(
              ctx
                .call("vortex_evaluate", { tabId: bgTabId, code: burstCode })
                .catch(() => undefined)
                .finally(() => {
                  burstInFlight--;
                }),
            );
          }
          await sleep(BG_BURST_INTERVAL_MS);
        }
        // 排空在途请求（别让它们在 tab 关掉之后还在飞）。
        await Promise.allSettled(pendingBurst);

        // ── ⑧ 等前台 idle 判定 ─────────────────────────────────────────────
        const idleText = extractText(await idlePromise);
        const idleElapsed = Date.now() - idleIssuedAt;
        const idleResult = parseJsonObject(idleText) ?? {};
        ctx.recordMetric("fgIdleWallMs", idleElapsed);
        ctx.recordMetric("bgBurstCount", burstCount);

        // 前台 idle **不该**报错：被后台持续请求拖到超时 = 隔离失效（负向验证的红）。
        ctx.assert(
          !/Error \[/.test(idleText),
          `前台 idle 判定不应报错（被后台慢请求拖到超时），实际: ${idleText.slice(0, 200)}`,
        );

        // 监听器武装过了：探针请求被计入 matchedRequests（否则可能整段空转）。
        const matched = typeof idleResult.matchedRequests === "number" ? idleResult.matchedRequests : -1;
        ctx.assert(
          matched >= 1,
          `前台 idle 监听器必须已武装（探针请求应被计入 matchedRequests），实际 matchedRequests=${matched}`,
        );

        const waitedMs = typeof idleResult.waitedMs === "number" ? idleResult.waitedMs : null;
        ctx.assert(
          waitedMs != null,
          `前台 idle 结果必须带 waitedMs（判定时刻要用它推算），实际: ${idleText.slice(0, 200)}`,
        );

        // ── B2：前台没被后台慢请求拖住 ──────────────────────────────────────
        // 静默期语义下，前台 idle ≈ idleTime(500ms) 就返回；隔离失效（前台去等后台
        // 那条 6000ms 的慢请求）时耗时会 ≫ SLOW_MS/2。
        ctx.assert(
          (waitedMs as number) < SLOW_MS / 2,
          `B2 前台 idle 不应被后台 ${SLOW_MS}ms 慢请求拖住（waitedMs=${waitedMs} 应 ≪ ${SLOW_MS}ms）`,
        );
        ctx.assert(
          idleElapsed < SLOW_MS,
          `B2 前台 idle 调用本身不应被拖到后台慢请求的时长（实际 ${idleElapsed}ms，应 < ${SLOW_MS}ms）`,
        );

        // ── 前提校验：慢请求确实落在监听窗口内 ────────────────────────────────
        const state = extractEvalJson<SlowRequestState>(
          await ctx.call("vortex_evaluate", {
            tabId: bgTabId,
            code: `(function(){
              var s = window.__vortexSlowStart;
              return {
                start: (typeof s === "number" ? s : null),
                now: Date.now()
              };
            })()`,
          }),
        );

        if (state.start == null) {
          lastReason = "后台页面没有记录到慢请求的发起时刻";
          continue;
        }
        // 前台 idle 判定时刻的下界：页面记的 t0 + 扩展回传的 waitedMs。
        const idleDecidedAt = t0 + (waitedMs as number);
        ctx.assert(
          state.start <= idleDecidedAt,
          `慢请求应在前台 idle 判定之前发起（发起 ${state.start} > 判定 ${idleDecidedAt}）`,
        );
        ctx.assert(
          idleDecidedAt - state.start < SLOW_MS,
          `前台 idle 判定时刻慢请求应仍在飞（判定 ${idleDecidedAt} - 发起 ${state.start} >= ${SLOW_MS}ms）`,
        );

        // ── B1：无跨 tab 泄漏 ───────────────────────────────────────────────
        // network 日志由 handlers/network.ts **按 tab 独立维护**，与 awaitIdle 的
        // tab 过滤是**两条独立的链路** —— 所以 B1 单独锁「日志不串台」。
        const fgNetText = extractText(
          await ctx.call("vortex_debug_read", { source: "network", pattern: "slow", tabId: fgTabId }),
        );
        const fgSlow = slowEntries(parseLogEntries(fgNetText));
        ctx.assert(
          fgSlow.length === 0,
          `B1 前台 tab 的网络日志不应出现后台的 /slow 条目（跨 tab 泄漏），实际 ${fgSlow.length} 条: ${JSON.stringify(fgSlow).slice(0, 300)}`,
        );

        // B1 的阳性对照：后台 tab 的日志里**必须**有 /slow 条目。
        // 没有 ⇒ 后台请求压根没进日志（订阅没生效 / 请求没发出）⇒ B1 的「前台没有」
        // 就是空洞的真（假绿）。这里等一小会儿让请求进日志（响应本身有 100ms 延迟）。
        let bgSlow: LogEntry[] = [];
        for (let i = 0; i < 20 && bgSlow.length === 0; i++) {
          const bgNetText = extractText(
            await ctx.call("vortex_debug_read", { source: "network", pattern: "slow", tabId: bgTabId }),
          );
          bgSlow = slowEntries(parseLogEntries(bgNetText));
          if (bgSlow.length === 0) await sleep(100);
        }
        if (bgSlow.length === 0) {
          lastReason = "后台 tab 的网络日志里没有 /slow 条目（请求没进日志，B1 无对照）";
          continue;
        }

        // 前提校验：后台的持续请求确实落在前台 idle 的监听窗口内 ——
        // 否则「后台持续发请求」这件事本身没发生，B3′ 的放大器就不成立。
        const burstInWindow = bgSlow.filter(
          (e) => typeof e.startTime === "number" && e.startTime >= t0 && e.startTime <= idleDecidedAt,
        );
        if (burstInWindow.length === 0) {
          lastReason = `后台持续请求没有落在前台 idle 的监听窗口内（t0=${t0} ~ 判定=${idleDecidedAt}，日志里的 /slow 起点: ${JSON.stringify(bgSlow.map((e) => e.startTime))}）`;
          continue;
        }

        return;
      } finally {
        if (bgTabId != null) {
          try {
            await ctx.call("vortex_tab_close", { tabId: bgTabId });
          } catch {
            // 收尾失败不影响判定（用例已经在上面断言过了）。
          }
        }
      }
    }

    ctx.assert(false, `事件隔离用例前提始终不成立：${lastReason}`);
  },
};

export default def;
