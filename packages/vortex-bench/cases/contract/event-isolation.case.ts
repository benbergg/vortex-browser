// 事件隔离（suite B）：前台的 idle 判定**不能**被后台 tab 的慢请求拖住。
//
// 契约：扩展的 awaitIdle 只跟踪**本 tab** 的 CDP 网络事件
// （packages/extension/src/handlers/page.ts 的 `if (evtTabId !== tid) return;`）。
// 后台 tab 的慢请求不该让前台的 vortex_wait_for(mode=idle) 报错或超时。
//
// 时序是本用例的全部要害 —— 旧版是**假绿**窗口：
//   旧时序「后台慢请求先发出 → 等 600ms → 才启动前台 idle」时，扩展的 awaitIdle
//   在**调用时**新建空 tracked 集合，只记录之后的 requestWillBeSent，
//   已经发出去的慢请求根本进不了集合 ⇒ 就算把 tab 事件过滤删掉，用例照样通过。
//   旧版还把「后台 tab 的 status === loading」当成「慢请求在飞」的证据，
//   而 tab status 说的是**文档**加载状态，跟页面里的 fetch 无关 —— 前提本身是假的。
//
// 现在的时序：
//   ① 后台 tab 建好、文档加载完成
//   ② **后台网络监听先启用**（debug_read → network 订阅 → CDP Network 域 enable）
//      —— 不开的话后台请求根本不产生 CDP 事件，测的就不是"隔离"而是"没监听"
//   ③ **前台也先把 Network 域打开**（同上）—— awaitIdle 里那句 enableDomain
//      于是变成同步空操作，监听器在同一个 tick 内注册完；否则「监听注册」与
//      「后台请求发出」是竞态，用例可能整段落空（又是一个假绿窗口）。
//   ④ **前台开始 idle 监听**（不 await）
//   ⑤ **再**触发后台慢请求（fetch /slow?ms=6000），页面里记下发起时刻；
//      同时在前台发一个探针请求，用来证明监听器确实已经武装（matchedRequests ≥ 1）
//   ⑥ 等前台 idle 判定返回：必须不报错、matchedRequests ≥ 1、耗时要短
//   ⑦ 前提校验：慢请求发起时刻 ≤ 前台 idle 判定时刻 < 慢请求结束时刻
//      —— 证明慢请求**确实落在监听窗口内**，否则本用例就是空转
//
// 时刻口径：发起时刻取**页面时钟**（浏览器进程），idle 判定时刻用
// 「前台页面在开监听前记下的时刻 + 扩展回传的 waitedMs」—— 三者同一台浏览器、
// 同一时钟，且后者是判定时刻的**下界**（扩展的计时起点晚于页面记录时刻），
// 于是判定更严格而不是更宽松。
//
// 删掉扩展里的 tab 事件过滤后本用例会变红：
// 见 packages/vortex-bench/tests/event-isolation-case.test.ts（模拟扩展语义的回归测试）。
import type { CaseDefinition } from "../../src/types.js";
import { extractText, extractEvalJson } from "../_helpers.js";

/** 后台慢请求的时长（fixture 的 /slow?ms=N 会延迟 N ms 才响应）。 */
const SLOW_MS = 6000;
/**
 * 前台 idle 的超时。**必须 < SLOW_MS**：否则即使没有隔离，
 * 超时也会晚于慢请求结束才触发 → 用例照样"通过"（假绿）。
 */
const IDLE_TIMEOUT_MS = 4000;
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
}

/**
 * 从工具返回文本里抠出日志条目数组。
 *
 * 两种形态都要认：非空时是裸数组 `[{...}]`；空时是自陈信封
 * `{"__vtxDiagnosis":"...","value":[]}`。
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

/** 等后台 tab 的文档加载完成（tab.status 说文档，不说页面里的 fetch）。 */
async function waitForTabLoaded(
  ctx: { call: (name: string, args: Record<string, unknown>) => Promise<unknown> },
  tabId: number,
): Promise<boolean> {
  const deadline = Date.now() + BG_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tabs = JSON.parse(extractText(await ctx.call("vortex_tab_list", {}))) as Array<{
      id?: number;
      status?: string;
    }>;
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const def: CaseDefinition = {
  name: "contract/event-isolation",
  suite: "b",
  async run(ctx) {
    let lastReason = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      lastReason = "";
      let bgTabId: number | null = null;
      try {
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
          await ctx.call("vortex_debug_read", { source: "network", pattern: "slow" }),
        );
        ctx.assert(
          !/Error \[/.test(fgSubscribe),
          `前台网络订阅调用不应报错，实际: ${fgSubscribe.slice(0, 200)}`,
        );

        // ── ④ 前台页面记下开监听前的时刻（浏览器时钟，与慢请求发起时刻同轴）──
        const t0 = extractEvalJson<number>(
          await ctx.call("vortex_evaluate", {
            code: `return Date.now();`,
          }),
        );

        // ── ⑤ 前台开始 idle 监听（不 await！）────────────────────────────────
        const idlePromise = ctx.call("vortex_wait_for", {
          mode: "idle",
          value: "network",
          timeout: IDLE_TIMEOUT_MS,
        });

        // ── ⑥ 在监听窗口内：前台探针 + 后台慢请求 ───────────────────────────
        // 探针走前台（会被计入 matchedRequests），用来证明监听器真的武装好了；
        // 慢请求走后台，是被测对象。两条 evaluate 按序发出 ⇒ 探针的
        // requestWillBeSent 一定早于慢请求的。
        const slowUrl = `${ctx.baseUrl}/slow?ms=${SLOW_MS}`;
        const probeUrl = `${ctx.baseUrl}/child`;
        const probePromise = ctx.call("vortex_evaluate", {
          code: `(function(){
            window.fetch(${JSON.stringify(probeUrl)}).catch(function(){});
            return "probe";
          })()`,
        });
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
        await probePromise;

        // ── ⑦ 等前台 idle 判定 ─────────────────────────────────────────────
        const idleText = extractText(await idlePromise);
        const idleResult = parseJsonObject(idleText) ?? {};

        if (!issued.includes("issued")) {
          lastReason = `后台慢请求未发出：${issued.slice(0, 200)}（前台 idle：${idleText.slice(0, 120)}）`;
          continue;
        }

        ctx.assert(
          !/Error \[/.test(idleText),
          `前台 idle 判定不应报错（被后台慢请求拖到超时），实际: ${idleText.slice(0, 200)}`,
        );

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

        // ── ⑧ 前提校验：慢请求确实落在监听窗口内 ────────────────────────────
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
