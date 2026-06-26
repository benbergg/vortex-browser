import { DomActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { resolveTarget, resolveTargetOptional } from "../lib/resolve-target.js";
import { pageQuery as nativePageQuery, mapPageError } from "../adapter/native.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";
import { clickBBox as cdpClickBBox, cdpClickElement } from "../adapter/cdp.js";
import { getIframeOffset } from "../lib/iframe-offset.js";
import {
  runCascaderDriverCDP,
  runDateRangeDriverCDP,
  runTimePickerDriverCDP,
} from "../adapter/cdp-drivers/index.js";
import {
  FILL_REJECT_PATTERNS,
  findDriver,
  COMMIT_DRIVERS,
  type CommitKind,
} from "../patterns/index.js";
import { waitActionable } from "../action/auto-wait.js";
import { waitActionableAutoForce } from "../action/wait-actionable-auto-force.js";
import { isStaleNotAttached, tryHealSelector } from "../action/heal.js";

/**
 * 判断元素是否为"瞬态覆盖层"(react-virtuoso 动画层 / popper 浮层 / 滚动视口
 * 元素未到视口时标 aria-hidden 等)。这些元素:
 *   - 视觉上短暂存在 (opacity 动画、transform 动画)
 *   - 命中 elementFromPoint(cx, cy) 但不是真遮挡
 *   - 真点击会从 root delegation 派发到目标 ref (React 事件冒泡)
 *
 * BUG-012 N0060 京东选品评测 V1: 京东家电/服饰评价区使用 react-virtuoso
 * 虚拟列表, 容器与 viewport 间有"动画覆盖层" (opacity < 1 / transform
 * 滚动 / aria-hidden 容器), elementFromPoint 命中覆盖层 → vortex click
 * 误报 ELEMENT_OCCLUDED。抽成纯函数供 click probe 放行 transient overlay。
 *
 * 三条件任一命中 → transient:
 *   1. opacity < 0.99 (淡入/淡出动画中)
 *   2. transform 含 matrix (translate/scale 动画)
 *   3. aria-hidden="true" (react-virtuoso 评价项未到视口时标)
 *
 * 真实遮挡 (京东物流弹层遮罩) opacity=1, transform=定位 matrix,
 * aria-hidden="false" → 不被误判为 transient → 仍报 ELEMENT_OCCLUDED。
 */
// 注意:本函数在 CLICK handler 的 executeScript inline func 内有一份**内联副本**
// (executeScript 注入丢模块作用域,裸引用模块级 helper 会 ReferenceError——
// 2026-06-10 spike 实测非 trusted Chrome 合成 click 100% 抛错即此因)。
// 真源+内联副本,改一处须改另一处;tests/click-synthetic-inline-scope.test.ts
// 用 new Function 剥离作用域真执行守护。
export function isTransient(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (parseFloat(cs.opacity) < 0.99) return true;
  if (cs.transform && cs.transform !== "none" && cs.transform.includes("matrix")) {
    return true;
  }
  if (el.getAttribute("aria-hidden") === "true") return true;
  return false;
}

// dialog 应答策略 arm/read 共享 helper(各一次 world:MAIN executeScript)。
// 动作交互前 arm(override 据此抑制 + 应答弹窗),交互后 read+grace-disarm。
async function armDialogPolicy(
  tid: number, frameId: number | undefined,
  answer: "accept" | "dismiss", promptText: string | null,
): Promise<void> {
  await chrome.scripting.executeScript({
    target: buildExecuteTarget(tid, frameId), world: "MAIN",
    func: (a: string, pt: string | null) => {
      (window as any).__vortexDialogPolicy = {
        armed: true, until: 0, answer: a === "accept" ? "accept" : "dismiss",
        promptText: pt, captured: [],
      };
    },
    args: [answer, promptText],
  });
}

async function readDialogCapturedAndDisarm(
  tid: number, frameId: number | undefined,
): Promise<Array<{ type: string; message: string }>> {
  const r = await chrome.scripting.executeScript({
    target: buildExecuteTarget(tid, frameId), world: "MAIN",
    func: () => {
      const d = (window as any).__vortexDialogPolicy;
      const cap = (d?.captured ?? []) as Array<{ type: string; message: string }>;
      if (d) { d.armed = false; d.until = Date.now() + 1000; }
      return cap;
    },
  });
  return (r[0]?.result as Array<{ type: string; message: string }>) ?? [];
}

/**
 * 包裹 actionability gate：选择器因 NOT_ATTACHED 自旋失败且有 descriptor 时，
 * 按 descriptor 重匹配换选择器再跑一次 gate。返回最终（可能已自愈的）选择器。
 */
export async function healAwareGate(
  tabId: number,
  frameId: number | undefined,
  selector: string,
  options: { timeout: number | undefined; needsEditable?: boolean },
  force: boolean | undefined,
  descriptor: { role?: string; name: string } | undefined,
): Promise<{ selector: string; healed: boolean }> {
  // B2:首跑 gate 即注入自旋期重定位(descriptor 存在才有意义),让高频重渲染元素
  // 在 2s 超时前就被按名重新锁定,而非死等超时后才一次性 heal。
  const reresolve = descriptor
    ? () => tryHealSelector(tabId, frameId, descriptor).catch(() => null)
    : undefined;
  try {
    // B2 修复：采纳 waitActionableAutoForce 返回的 selector，自旋期 descriptor 重定位后
    // curSelector 已切换，ok.selector ≠ 入参 selector → healed:true，下游用新选择器。
    const ok = await waitActionableAutoForce(tabId, frameId, selector, { ...options, reresolve }, force);
    return { selector: ok.selector, healed: ok.selector !== selector };
  } catch (err) {
    if (descriptor && isStaleNotAttached(err)) {
      const healed = await tryHealSelector(tabId, frameId, descriptor); // 抛 AMBIGUOUS_DESCRIPTOR/STALE_REF
      await waitActionableAutoForce(tabId, frameId, healed, options, force);
      return { selector: healed, healed: true };
    }
    throw err;
  }
}

export function registerDomHandlers(
  router: ActionRouter,
  debuggerMgr: DebuggerManager,
): void {
  router.registerAll({
    [DomActions.QUERY]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string) => {
          try {
            const el = document.querySelector(sel);
            if (!el) return { result: null };
            const attrs: Record<string, string> = {};
            for (const attr of Array.from(el.attributes)) {
              attrs[attr.name] = attr.value;
            }
            return {
              result: {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                classes: Array.from(el.classList),
                text: (el as HTMLElement).innerText?.slice(0, 500),
                attributes: attrs,
              },
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.QUERY_ALL]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string) => {
          try {
            const elements = Array.from(document.querySelectorAll(sel)).slice(0, 100);
            return {
              result: elements.map((el) => {
                const attrs: Record<string, string> = {};
                for (const attr of Array.from(el.attributes)) {
                  attrs[attr.name] = attr.value;
                }
                return {
                  tag: el.tagName.toLowerCase(),
                  id: el.id || undefined,
                  classes: Array.from(el.classList),
                  text: (el as HTMLElement).innerText?.slice(0, 200),
                  attributes: attrs,
                };
              }),
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.CLICK]: async (args, tabId) => {
      const __t = resolveTarget(args);
      // let 声明：gate 自愈后用 __heal.selector 重绑，下游所有引用统一用 selector。
      let selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const useRealMouse = args.useRealMouse as boolean | undefined;
      // flag-自适应:server 在 trusted Chrome(带 --silent-debugger-extension-api)下注入
      // trustedMode=true。此时 click 默认走 CDP trusted(无黄条、广覆盖 isTrusted-gated),
      // 等价于隐式 useRealMouse。非 trusted 时落到下方合成 + submit-intent 路径(不变)。
      const trustedMode = args.trustedMode === true;
      // GAP-G(N0062): click 效果信号采集。opt-in,默认关(零开销)。开启时派发前后采集
      // 非判定性证据(domMutations/urlChanged/focusChanged/ariaChanged),让 agent 自判
      // silent failure——success 不翻转。见知识库 N0062 GAP-G 设计 / page-side/click-effect.ts。
      const observeEffect = args.observeEffect === true;
      const windowMs = args.windowMs as number | undefined;
      const explicitOnDialog = args.onDialog !== undefined;

      // L2 integration: actionability + descriptor 自愈 gate。
      // NOT_ATTACHED 自旋到 TIMEOUT 且有 descriptor 时，healAwareGate 按 descriptor
      // 重匹配元素、换选择器再跑一次 gate。无 descriptor 或非 stale 错误则原样抛。
      // NOT_STABLE 自动 force 重试逻辑在 waitActionableAutoForce 内已覆盖。
      const __heal = await healAwareGate(
        tid,
        frameId,
        selector,
        // 不覆盖默认:未传 timeout 时透传 undefined,由 waitActionable 落到
        // DEFAULT_TIMEOUT_MS(2000)。历史 `?? 5000` 覆盖让 perf 修复成死代码。
        { timeout: args.timeout as number | undefined },
        args.force as boolean | undefined,
        __t.descriptor,
      );
      // 重绑 selector：若已自愈则改为 healed selector，下游所有路径（早返回/CDP/合成）统一引用。
      selector = __heal.selector;

      // 把 page-side 返回的 raw dialogs 数组转成对外 dialogHandled 字段 + 默认 dismiss 的 warning。
      // 定义前置(原在 deferToCdp 段下方)——使下方 useRealMouse/trustedMode 早返回分支也能套用。
      // 否则 trusted 模式(Chrome 带 flag,click 默认走 CDP)下该分支返回 raw dialogs 无
      // dialogHandled,a05536b 漏覆盖此路径。(2026-06-13 antd Pro dogfood bench 副产)
      const attachDialogHandled = (r: unknown): unknown => {
        const obj = r as { dialogs?: Array<{ type: string; message: string }> } | undefined;
        if (!obj?.dialogs?.length) return r;
        const first = obj.dialogs[0];
        const policy = (args.onDialog as string) === "accept" ? "accepted" : "dismissed";
        const needsWarn = !explicitOnDialog && (first.type === "confirm" || first.type === "prompt");
        const { dialogs, ...restResult } = obj;
        return {
          ...restResult,
          dialogHandled: {
            type: first.type, message: first.message, policy,
            ...(needsWarn ? { warning: "未设 onDialog,已默认 dismiss;若本意是确认请带 onDialog:accept 重试" } : {}),
          },
        };
      };

      if (useRealMouse || trustedMode) {
        // 预加载 dom-resolve,使 cdpClickElement 的 page-side 探测能经
        // __vortexDomResolve 穿 open shadow + 走门同款 isEnabled——与同步路径一致,
        // 堵 shadow-internal ref 假阴 ELEMENT_NOT_FOUND(#14)。
        await loadPageSideModule(tid, frameId, "dom-resolve");
        if (observeEffect) await loadPageSideModule(tid, frameId, "click-effect");
        const cdpResult = attachDialogHandled(await cdpClickElement(debuggerMgr, tid, frameId, selector, {
          force: args.force as boolean | undefined,
          observeEffect,
          windowMs,
          onDialog: args.onDialog as string | undefined,
          promptText: (args.promptText as string | undefined) ?? null,
        }));
        return __heal.healed ? { ...(cdpResult as object), healed: true } : cdpResult;
      }

      // 普通 element.click() 路径（含失败探测）
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      if (observeEffect) await loadPageSideModule(tid, frameId, "click-effect");
      // 方案 A:可重跑闭包。cdpAvailable=true 时页内 func 对 submit-intent 元素返回
      // deferToCdp(不合成点击)→ handler 改走 CDP trusted;CDP 失败时用 false 重跑合成。
      const runSyntheticClick = async (cdpAvailable: boolean) => {
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: async (sel: string, cdpAvailable: boolean, observeEffect: boolean, windowMs: number | undefined, dialogAnswer: string, dialogPromptText: string | null) => {
          try {
            // 探测阶段：逐项检查失败原因，细化错误码
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLElement;
            // 探测 disabled 走门同款 isEnabled(含 aria-disabled),与 actionability 门一致,
            // 旧版只判 .disabled 漏 aria-disabled div[role=textbox] 等(#26/#29)。
            if (!(window as any).__vortexDomResolve.isEnabled(el)) {
              return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
            }
            const rect0 = el.getBoundingClientRect();
            if (rect0.width === 0 || rect0.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            // offscreen 检查（滚入视口之前）
            const inView =
              rect0.top < window.innerHeight &&
              rect0.bottom > 0 &&
              rect0.left < window.innerWidth &&
              rect0.right > 0;
            if (!inView) {
              return {
                errorCode: "ELEMENT_OFFSCREEN",
                error: `Element ${sel} is outside the viewport`,
              };
            }
            // 元素已完全在视口内 → 跳过 scrollIntoView(同 cdp.ts useRealMouse / mouse.ts
            // drag 守卫):无谓 block:center 在动态画布上触发容器滚动+弹回,使 occlusion
            // 检查坐标失效误判(2026-06-14 dogfood B2)。未完全可见才滚(必要)。
            const __vw = window.innerWidth, __vh = window.innerHeight;
            const __fullyInView =
              rect0.top >= 0 && rect0.left >= 0 &&
              rect0.bottom <= __vh && rect0.right <= __vw;
            if (!__fullyInView) {
              el.scrollIntoView({ block: "center", inline: "center" });
            }
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // 使用穿 shadow 的 deepElementFromPoint，避免对 shadow-internal 元素返回 shadow host
            // 导致 host.contains(el) 不穿 shadow 而误判 ELEMENT_OCCLUDED。
            const topEl = (window as any).__vortexDomResolve.deepElementFromPoint(cx, cy);
            // 复合输入控件(Element Plus el-select 等)把可见显示层(placeholder /
            // selected-item)作为兄弟节点叠在透明真控件之上。hit-test 命中显示层兄弟——
            // 既非 target 也非其后代——但它非交互且与 target 同处一个交互 widget 容器
            // (el 的最近交互祖先 contains hit),点击经显示层冒泡仍到达控件,非真遮挡。
            // 与 actionability.ts / cdp.ts 的 carve-out 同源(2026-06-01 el-select dogfood)。
            const isInteractiveEl = (x: Element): boolean => {
              const t = x.tagName.toLowerCase();
              return (
                !!x.getAttribute("role") ||
                x.getAttribute("tabindex") != null ||
                t === "button" ||
                t === "a" ||
                t === "input" ||
                t === "select" ||
                t === "textarea"
              );
            };
            let sameWidgetDecoration = false;
            if (topEl && !isInteractiveEl(topEl)) {
              let w: Element | null = el.parentElement;
              while (w && w !== document.documentElement) {
                if (isInteractiveEl(w)) {
                  if (w.contains(topEl)) sameWidgetDecoration = true;
                  break;
                }
                w = w.parentElement;
              }
            }
            // BUG-012 N0060 京东评测: react-virtuoso 虚拟列表容器与 viewport 间
            // 有"动画覆盖层" (opacity/transform 动画 + aria-hidden 容器),
            // elementFromPoint 命中覆盖层而非目标 ref, 但点击经 React root
            // delegation 仍能到达目标。在 isInteractiveEl 失败后追加 isTransient
            // 检测, 命中 transient overlay → 放行。真遮挡 (京东物流弹层遮罩)
            // opacity=1 / transform=定位 matrix / aria-hidden="false" → 不被
            // 误判, 仍报 ELEMENT_OCCLUDED。
            // isTransient 内联副本(与模块级 export 同步,改一处须改另一处——
            // executeScript 注入丢模块作用域,不能裸引用模块 helper)。
            const isTransientInline = (x: Element | null): boolean => {
              if (!x) return false;
              const cs = getComputedStyle(x);
              if (parseFloat(cs.opacity) < 0.99) return true;
              if (cs.transform && cs.transform !== "none" && cs.transform.includes("matrix")) {
                return true;
              }
              if (x.getAttribute("aria-hidden") === "true") return true;
              return false;
            };
            const isTransientOverlay = isTransientInline(topEl);
            if (
              topEl &&
              topEl !== el &&
              !el.contains(topEl) &&
              !topEl.contains(el) &&
              !sameWidgetDecoration &&
              !isTransientOverlay
            ) {
              const classStr =
                typeof topEl.className === "string" && topEl.className
                  ? "." + topEl.className.split(" ").filter(Boolean).join(".")
                  : "";
              const desc =
                topEl.tagName.toLowerCase() +
                (topEl.id ? "#" + topEl.id : "") +
                classStr;
              return {
                errorCode: "ELEMENT_OCCLUDED",
                error: `Element ${sel} is covered by <${desc}>`,
                extras: { blocker: desc },
              };
            }
            // 方案 A:表单提交意图元素(button[type=submit] / input[type=submit] /
            // <form> 内无显式 type 的 <button>——HTML 默认 type=submit)。合成 click 的
            // isTrusted=false,React 拦截 submit 的站点(淘宝搜索)会丢弃且常清空输入框;
            // 扩展里唯一能发 trusted 的是 CDP。故跳过合成、交给 cdpClickElement 真鼠标。
            // cdpAvailable=false(CDP 探测失败回退)时不 defer,照常合成。
            const __tagLc = el.tagName.toLowerCase();
            const __typeAttr = (el.getAttribute("type") || "").toLowerCase();
            const __isSubmitIntent =
              (__tagLc === "button" || __tagLc === "input") &&
              (__typeAttr === "submit" ||
                (__tagLc === "button" &&
                  __typeAttr !== "button" &&
                  __typeAttr !== "reset" &&
                  !!el.closest("form")));
            if (__isSubmitIntent && cdpAvailable) {
              return {
                result: {
                  deferToCdp: true,
                  element: {
                    tag: __tagLc,
                    id: el.id || undefined,
                    text: (el as HTMLElement).innerText?.slice(0, 200),
                  },
                },
              };
            }
            // BUG-010 N0060 京东评测 B 方案: 元素被 observe emit 阶段标
            // el.dataset.vortexReactClickable='1' (React/Vue onClick 桩 / cursor:pointer),
            // 合成 click isTrusted=false 拦截, 必须 CDP real mouse 兜底。
            // 顺序: 在 submit-intent 之后追加 (submit 优先, react-clickable 兜底)。
            // cdpAvailable=false 时不 defer, 让合成 click 至少尝试(无 CDP 时连尝试都不给
            // 等于把可用 click 路径堵死, 反而降级)。
            const __isReactClickable = el.dataset?.vortexReactClickable === "1";
            if (__isReactClickable && cdpAvailable) {
              return {
                result: {
                  deferToCdp: true,
                  element: {
                    tag: __tagLc,
                    id: el.id || undefined,
                    text: (el as HTMLElement).innerText?.slice(0, 200),
                  },
                },
              };
            }
            // 坐标敏感控件(role=slider / input[type=range]):值由指针 clientX/Y 命中位置
            // 计算,合成 el.click() 的 clientX=clientY=0 → 控件按位置 0 取最小值,值不变却
            // 返回 success → silent success(Shoelace sl-rating / 原生 range / canvas slider)。
            // 这类控件不带 vortexReactClickable(非 React onClick 桩,纯坐标驱动),故 react-clickable
            // 门漏掉。CDP real mouse 点中元素中心 → 落到真实坐标驱动控件改值(中心≈中间档)。
            // cdpAvailable=false 时不 defer,退回 el.click() 至少触发监听器(无 CDP 不堵路,
            // 与 submit-intent/react-clickable 同策)。(2026-06-23 shoelace rating dogfood:
            // 默认 click slider value 恒 0;useRealMouse 中心点击 value=3 实证)
            // __hasClickMethod 守卫:仅当 el.click() 真会被调(下方 508 行分支)才需 defer——
            // 无 .click() 方法的 SVG role=slider(<g> 等,APG multi-thumb)走 dispatchEvent
            // 分支,属 2026-06-22 APG dogfood 既有处理,不在本修复范围内,放行保留其行为。
            const __hasClickMethod = typeof (el as { click?: unknown }).click === "function";
            const __roleAttr = (el.getAttribute("role") || "").toLowerCase();
            const __isCoordSensitive =
              __hasClickMethod &&
              (__roleAttr === "slider" ||
                (__tagLc === "input" && __typeAttr === "range"));
            if (__isCoordSensitive && cdpAvailable) {
              return {
                result: {
                  deferToCdp: true,
                  element: {
                    tag: __tagLc,
                    id: el.id || undefined,
                    text: (el as HTMLElement).innerText?.slice(0, 200),
                  },
                },
              };
            }
            // GAP-G(N0062): 派发前启动效果信号采集(opt-in)。begin 在 focus/dispatch 之前,
            // 捕获点击前 url/activeElement/aria 快照,使后续 focus/dispatch 引起的变化都计入。
            // 经 window.__vortexClickEffect(loadPageSideModule 预注入),禁止 inline 复制逻辑。
            let __effectToken: string | undefined;
            const __ce = (window as unknown as {
              __vortexClickEffect?: { begin(s: string, w: number): string; end(t: string): Promise<unknown> };
            }).__vortexClickEffect;
            if (observeEffect && __ce) {
              __effectToken = __ce.begin(sel, windowMs ?? 300);
            }
            // 通过所有检查，执行 click；对可 focus 元素（input/textarea/button/select）
            // 先 focus 再 click，保证后续 vortex_press 键盘事件能落在 active element 上
            // （JS .click() 不像真实鼠标那样顺带 focus，修掉这个行为差异）
            if (typeof (el as HTMLElement).focus === "function") {
              try {
                (el as HTMLElement).focus();
              } catch {
                // swallow: focus 不是所有元素都支持
              }
            }
            // Dispatch full pointer/mouse event sequence so frameworks that
            // hook mousedown/mouseup (AngularJS Material $mdGesture/tapClick,
            // Hammer.js, Ant Design v3 Select, pre-3.0 Element UI Select)
            // observe what looks like a real tap. Without this, those
            // frameworks see only a lone click() and silently ignore it,
            // which is why md-select dropdowns refused to open during the
            // 2026-05-21 RocketMQ dogfood (BUG 8, P0).
            //
            // Order matches the W3C "click activation" spec: pointerdown →
            // mousedown → pointerup → mouseup → click. We then still call
            // el.click() so element-level click handlers (form submit /
            // anchor navigation) fire reliably even when intermediate
            // listeners stopPropagation.
            // dialog 应答 arm:点击可能同步触发 confirm/alert/prompt,override 据此抑制 + 应答。
            // armed 无时限覆盖整个派发;读 captured 后置 until grace 覆盖 setTimeout 异步弹框。
            (window as any).__vortexDialogPolicy = {
              armed: true, until: 0,
              answer: dialogAnswer === "accept" ? "accept" : "dismiss",
              promptText: dialogPromptText, captured: [],
            };
            const ptrInit: PointerEventInit = {
              bubbles: true, cancelable: true, composed: true, view: window,
              button: 0, buttons: 1, clientX: cx, clientY: cy,
              pointerType: "mouse", pointerId: 1, isPrimary: true,
            };
            const mouseDown: MouseEventInit = {
              bubbles: true, cancelable: true, composed: true, view: window,
              button: 0, buttons: 1, clientX: cx, clientY: cy,
            };
            const mouseUp: MouseEventInit = {
              bubbles: true, cancelable: true, composed: true, view: window,
              button: 0, buttons: 0, clientX: cx, clientY: cy,
            };
            try { el.dispatchEvent(new PointerEvent("pointerdown", ptrInit)); } catch { /* PointerEvent unsupported */ }
            el.dispatchEvent(new MouseEvent("mousedown", mouseDown));
            try { el.dispatchEvent(new PointerEvent("pointerup", { ...ptrInit, buttons: 0 })); } catch { /* */ }
            el.dispatchEvent(new MouseEvent("mouseup", mouseUp));
            // 原生 .click() 仅 HTMLElement 有,SVGElement(<g role=slider>/<rect> 等)、MathML
            // 等无此方法 → 裸调抛 "X.click is not a function"(2026-06-22 APG multi-thumb
            // slider dogfood)。有则调(触发表单提交/锚点跳转等默认动作),无则派发合成 click
            // 事件触发监听器(非 HTML 元素无默认 click 动作,事件已够)。
            if (typeof (el as { click?: unknown }).click === "function") {
              el.click();
            } else {
              el.dispatchEvent(new MouseEvent("click", mouseUp));
            }
            // GAP-G(N0062): 派发后采集效果信号(await windowMs 窗口)。success 恒 true,effect
            // 仅作旁证;__effectToken 为空(未 opt-in / 模块未就绪)时不带 effect,保持零开销。
            const __effect = __effectToken && __ce ? await __ce.end(__effectToken) : undefined;
            // 读 dialog captured 并以 grace 时间戳 disarm(覆盖派发后短窗内的异步弹框)。
            const __dlg = (window as any).__vortexDialogPolicy;
            const __dialogs = (__dlg?.captured ?? []) as Array<{ type: string; message: string }>;
            if (__dlg) { __dlg.armed = false; __dlg.until = Date.now() + 1000; }
            return {
              result: {
                success: true,
                element: {
                  tag: el.tagName.toLowerCase(),
                  id: el.id || undefined,
                  text: el.innerText?.slice(0, 200),
                },
                ...(__effect ? { effect: __effect } : {}),
                ...(__dialogs.length ? { dialogs: __dialogs } : {}),
              },
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        // BUG-001 (N0063): windowMs 缺省时为 undefined,chrome.scripting.executeScript 的
        // args 走 structured clone 拒 undefined(报 "unserializable at index 3"),非 trusted
        // 合成路径默认 click 100% 崩。默认 300 对齐 page-side click-effect.ts 的 `windowMs ?? 300`
        // ——observeEffect=false 时该值不被使用(begin 不调),observeEffect=true 且未传时给回正确
        // 的 300ms 窗口(用 ?? 0 会因 0 非 nullish 把窗口塌成 0ms,故不可用 0)。observeEffect
        // 恒为 boolean(args.observeEffect === true),无需兜底。
        args: [selector, cdpAvailable, observeEffect, windowMs ?? 300, (args.onDialog as string) ?? "dismiss", (args.promptText as string | undefined) ?? null],
        world: "MAIN",
      });
      return results[0]?.result as {
        result?: { deferToCdp?: boolean } | unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      };
      };
      const throwIfClickError = (r: { error?: string; errorCode?: string; extras?: Record<string, unknown> } | undefined) => {
        if (r?.error) {
          const code: VtxErrorCode =
            r.errorCode && r.errorCode in VtxErrorCode
              ? (r.errorCode as VtxErrorCode)
              : r.error.startsWith("Element not found:")
                ? VtxErrorCode.ELEMENT_NOT_FOUND
                : VtxErrorCode.JS_EXECUTION_ERROR;
          throw vtxError(code, r.error, { selector, extras: r.extras });
        }
      };
      // 首跑:cdpAvailable=!!debuggerMgr。submit-intent 会返回 deferToCdp(未点击)。
      let res = await runSyntheticClick(!!debuggerMgr);
      throwIfClickError(res);
      const inner = res?.result as { deferToCdp?: boolean } | undefined;
      // observeEffect 透传:reactClickable 元素(如京东"加入购物车" div)走此 defer 分支,
      // 正是 GAP-G silent success 现场——CDP 路径同样需采集效果信号。click-effect 模块
      // 已在 runSyntheticClick 前预注入。
      if (inner?.deferToCdp) {
        try {
          const deferResult = attachDialogHandled(await cdpClickElement(debuggerMgr, tid, frameId, selector, {
            force: args.force as boolean | undefined,
            observeEffect,
            windowMs,
            onDialog: args.onDialog as string | undefined,
            promptText: (args.promptText as string | undefined) ?? null,
          }));
          return __heal.healed ? { ...(deferResult as object), healed: true } : deferResult;
        } catch {
          // CDP 探测/attach 失败 → 回退合成(cdpAvailable=false 强制不再 defer,本次真点击)。
          res = await runSyntheticClick(false);
          throwIfClickError(res);
          const fallbackResult = attachDialogHandled(res?.result);
          return __heal.healed ? { ...(fallbackResult as object), healed: true } : fallbackResult;
        }
      }
      const synthResult = attachDialogHandled(res?.result);
      return __heal.healed ? { ...(synthResult as object), healed: true } : synthResult;
    },

    [DomActions.TYPE]: async (args, tabId) => {
      const __t = resolveTarget(args);
      // let 声明：gate 自愈后用 __heal.selector 重绑，下游所有引用统一用 selector。
      let selector = __t.selector;
      const text = args.text as string;
      const delay = (args.delay as number | undefined) ?? 0;
      if (text == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: text");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // L2 integration: actionability + descriptor 自愈 gate。
      // needsEditable:true 保持与原 waitActionableAutoForce 调用一致（type 需可编辑元素）。
      // NOT_STABLE 自动 force 重试逻辑在 waitActionableAutoForce 内已覆盖。
      const __healType = await healAwareGate(
        tid,
        frameId,
        selector,
        { timeout: args.timeout as number | undefined, needsEditable: true },
        args.force as boolean | undefined,
        __t.descriptor,
      );
      // 重绑 selector：若已自愈则改为 healed selector，下游所有引用统一用 selector。
      selector = __healType.selector;

      // Probe target: shared validation + contentEditable detection.
      // The page-side handler below runs the legacy
      // dispatch-KeyboardEvent + el.value path used by every
      // input/textarea case in bench. Rich-text editors
      // (ProseMirror / Slate / Lexical / Notion / Confluence) reject
      // synthetic events (isTrusted=false) and don't expose .value,
      // so the host-side code routes them through CDP Input.insertText
      // — the only path that produces a native browser-source input
      // event capable of driving a real rich-text editor's
      // beforeinput → transaction pipeline.
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector。
      // 此处单次加载同时覆盖下方两处查询站点：probe（actionability 检测）与 input/textarea dispatch。
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const probe = await nativePageQuery<{
        ok?: true;
        isContentEditable?: boolean;
        ceText?: string;
        errorCode?: string;
        error?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string, selectAll: boolean) => {
          const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
          if (els.length === 0) {
            return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
          }
          if (els.length > 1) {
            return {
              errorCode: "SELECTOR_AMBIGUOUS",
              error: `Selector "${sel}" matched ${els.length} elements`,
              extras: { matchCount: els.length },
            };
          }
          const el = els[0] as HTMLElement;
          // 探测 disabled 走门同款 isEnabled(含 aria-disabled),与 CLICK/FILL 一致(#26)。
          if (!(window as any).__vortexDomResolve.isEnabled(el)) {
            return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
          }
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            return {
              errorCode: "ELEMENT_DETACHED",
              error: `Element ${sel} has zero dimensions (detached or hidden)`,
            };
          }
          const inView =
            rect.top < window.innerHeight &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.right > 0;
          if (!inView) {
            return {
              errorCode: "ELEMENT_OFFSCREEN",
              error: `Element ${sel} is outside the viewport`,
            };
          }
          // Pre-focus so the upcoming CDP insertText / dispatch
          // event chain has a focused element to land on. focus()
          // is idempotent if the element is already active.
          el.focus();
          // contentEditable clear-before:CDP Input.insertText 在选区/光标处插入,
          // 空选区时残留旧内容拼接(live 实测 type 一段文本得到 "NEWexisting")。
          // type 语义是「把这段文本写入字段」,故先全选已有内容,让 insertText 替换
          // 选区(产生合规 beforeinput,ProseMirror/Slate/Lexical 接受)——等价人手
          // Ctrl+A 后输入。仅对 contentEditable 且有文本要写时全选,type("") 保持
          // no-op,对齐 input/textarea 分支契约(2026-06-04 多 agent 审计 #4)。
          if (selectAll && el.isContentEditable) {
            const editSel = window.getSelection();
            if (editSel) {
              const range = document.createRange();
              range.selectNodeContents(el);
              editSel.removeAllRanges();
              editSel.addRange(range);
            }
          }
          return {
            ok: true,
            isContentEditable: el.isContentEditable === true,
            // 回读校验基线:contentEditable 写入前的文本(select-all 不改 textContent,
            // 此处捕获安全)。host 端 insertText 后比对,识别编辑器拒收(族 A 护栏)。
            ceText: el.isContentEditable ? (el.textContent ?? "") : undefined,
          };
        },
        [selector, text !== ""],
      );
      if (probe?.error) {
        mapPageError(probe, selector);
      }

      // dialog arm:type 操作(键盘事件序列 / CDP insertText)可能触发同步 confirm,默认 dismiss 防冻屏。
      await armDialogPolicy(tid, frameId, "dismiss", null);
      try {

      if (probe?.isContentEditable) {
        // contentEditable path — Input.insertText is the only way to
        // produce a trusted beforeinput event that ProseMirror /
        // Slate / Lexical / Notion / Confluence will accept.
        // Delay is honored by chunking per character; default 0
        // sends the whole text in one IPC roundtrip.
        await debuggerMgr.attach(tid);
        if (delay > 0) {
          for (const ch of text) {
            await debuggerMgr.sendCommand(tid, "Input.insertText", { text: ch });
            await new Promise((r) => setTimeout(r, delay));
          }
        } else {
          await debuggerMgr.sendCommand(tid, "Input.insertText", { text });
        }
        // 族 A silent-false-success 护栏(对齐 input/textarea 路径 786-793 的回读校验):
        // CDP Input.insertText 即便被编辑器 beforeinput.preventDefault(只读/受限富文本)
        // 拒绝也不抛错。回读 textContent,若非空文本写完内容完全未变(now===before)且未含
        // 写入文本(now!==txt)→ 编辑器拒收,报 NO_EFFECT 而非假成功(2026-06-20 白盒复现)。
        // now!==txt 排除「重输相同文本」假阳;成功插入必改 textContent(now!==before)已先排除。
        if (text !== "") {
          const verify = await nativePageQuery<{
            errorCode?: string;
            error?: string;
            extras?: Record<string, unknown>;
          } | undefined>(
            tid,
            frameId,
            (sel: string, before: string, txt: string) => {
              const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
              const now = els.length ? ((els[0] as HTMLElement).textContent ?? "") : "";
              if (now === before && now !== txt) {
                return {
                  errorCode: "NO_EFFECT",
                  error: `Element ${sel} rejected typed text "${txt}" (contentEditable unchanged; likely a read-only or input-guarded editor)`,
                  extras: { attempted: txt },
                };
              }
              return {};
            },
            [selector, probe?.ceText ?? "", text],
          );
          if (verify?.error) mapPageError(verify, selector);
        }
        const cdpTypeResult = { success: true, typed: text.length, path: "cdp-insertText" };
        return __healType.healed ? { ...cdpTypeResult, healed: true } : cdpTypeResult;
      }

      // input / textarea path — legacy synthetic dispatch (kept
      // byte-identical to v0.8 for every passing case in bench).
      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        async (sel: string, txt: string, delayMs: number) => {
          try {
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            const el = els[0] as HTMLInputElement;
            el.focus();
            // 原生 value setter:直接对 el.value 累加赋值会绕过 React/Vue 受控组件的
            // value tracker → onChange 读不到变化 → state 把值覆盖回去,逐字被吞(族 F #8)。
            // 用元素类型匹配的原生 setter(同 FILL 的受控绕过),plain input 结果相同、
            // 受控 input 才能正确同步(2026-06-03 act 原语白盒审计族 F)。
            const proto =
              el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : el instanceof HTMLInputElement
                  ? window.HTMLInputElement.prototype
                  : null;
            const nativeSet = proto
              ? Object.getOwnPropertyDescriptor(proto, "value")?.set
              : undefined;
            const setValue = (v: string) => {
              if (nativeSet) nativeSet.call(el, v);
              else (el as HTMLInputElement).value = v;
            };
            // clear-before:type 语义是「把这段文本输入到字段」,不清空会得到 旧值+新值
            // 的拼接(族 F #9)。先清空再输入。仅在有文本要输入时清空——type("") 保持
            // no-op,避免破坏性清空已有值(评审 M2)。
            if (String(txt) !== "") {
              setValue("");
              el.dispatchEvent(new InputEvent("input", { bubbles: true }));
            }

            // number/date/range 等非 text 类型逐字累加会产生无效中间态(如 "1"→"1.")
            // 被原生置空,final value≠text(族 F #10)。这类整体写入一次,不逐字模拟。
            const inputType = el instanceof HTMLInputElement ? el.type : "textarea";
            const charByChar =
              el instanceof HTMLTextAreaElement ||
              ["text", "search", "tel", "url", "email", "password", ""].includes(inputType);
            if (!charByChar) {
              setValue(txt);
              el.dispatchEvent(new InputEvent("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              // 用累加器而非每次读 el.value:delay>0 时受控组件可能在 setTimeout 间隙把
              // el.value 改回 state 值,读回累加会错乱(只剩末字符/重复,评审 M1)。
              let acc = "";
              for (const char of txt) {
                const eventInit = { key: char, bubbles: true, cancelable: true };
                el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
                el.dispatchEvent(new KeyboardEvent("keypress", eventInit));
                acc += char;
                setValue(acc);
                el.dispatchEvent(new InputEvent("input", { bubbles: true, data: char }));
                el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
                if (delayMs > 0) {
                  await new Promise((r) => setTimeout(r, delayMs));
                }
              }
            }
            // 回读校验副作用真发生(族 A 一致):非空 text 却读回空 = 被类型/格式约束拒绝。
            if (String(txt) !== "" && (el as HTMLInputElement).value === "") {
              return {
                errorCode: "NO_EFFECT",
                error: `Element ${sel} rejected typed text "${String(txt)}" (likely a format/type constraint, e.g. type=number/date); value is empty after type`,
                extras: { attempted: String(txt), type: inputType },
              };
            }
            return {
              result: {
                success: true,
                typed: txt.length,
                path: "page-side-dispatch",
                value: (el as HTMLInputElement).value,
              },
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, text, delay ?? 0],
      );
      if (res?.error) mapPageError(res, selector);
      const typeResult = res?.result;
      return __healType.healed ? { ...(typeResult as object), healed: true } : typeResult;
      } finally {
        await readDialogCapturedAndDisarm(tid, frameId);
      }
    },

    [DomActions.PASTE]: async (args, tabId) => {
      const __t = resolveTarget(args);
      // let 声明：gate 自愈后用 __heal.selector 重绑，下游所有引用统一用 selector。
      let selector = __t.selector;
      const text = args.text as string;
      const html = args.html as string | undefined;
      if (text == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: text");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // gate + descriptor 自愈(needsEditable:true,contenteditable 也算可编辑)。
      const __heal = await healAwareGate(
        tid, frameId, selector,
        { timeout: args.timeout as number | undefined, needsEditable: true },
        args.force as boolean | undefined,
        __t.descriptor,
      );
      selector = __heal.selector;

      await loadPageSideModule(tid, frameId, "dom-resolve");
      // MAIN world 单次注入:解析→聚焦→构造 DataTransfer→派发合成 paste→回读。
      // MAIN world 必需:DataTransfer/ClipboardEvent 须是页面 realm 对象,
      // 否则页面监听器读 e.clipboardData 跨 realm 取不到数据。
      const out = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        world: "MAIN",
        func: (sel: string, txt: string, htmlPayload: string | null) => {
          const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
          if (els.length === 0) return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
          const el = els[0] as HTMLElement;
          if (!el.isContentEditable) {
            return {
              ok: true, isContentEditable: false,
              error: `Element ${sel} is not contentEditable; vortex_paste is for rich-text editors — use vortex_fill for inputs/textareas`,
            };
          }
          el.focus();
          const before = el.textContent ?? "";
          const dt = new DataTransfer();
          dt.setData("text/plain", txt);
          if (htmlPayload != null) dt.setData("text/html", htmlPayload);
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
          const after = el.textContent ?? "";
          return { ok: true, isContentEditable: true, before, after, changed: after !== before };
        },
        args: [selector, text, html ?? null],
      });
      const r = out?.[0]?.result as {
        ok?: true; isContentEditable?: boolean; before?: string; after?: string;
        changed?: boolean; errorCode?: string; error?: string;
      } | undefined;
      // 族 A 护栏：注入无返回值（如 CSP 阻断）→ 静默假成功，改为响亮报错。
      if (r === undefined) {
        throw vtxError(
          VtxErrorCode.JS_EXECUTION_ERROR,
          `paste injection returned no result for ${selector} (injection may be blocked by CSP)`,
        );
      }
      if (r?.errorCode) mapPageError(r, selector);
      // 非 contentEditable:提示改用 fill(不假成功)。
      if (r && r.isContentEditable === false) {
        throw vtxError(VtxErrorCode.INVALID_TARGET, r.error ?? `Element ${selector} is not contentEditable; use vortex_fill`);
      }
      // 族 A 回读护栏:非空文本派发后内容未变 → 编辑器拒收(很可能校验 isTrusted)。
      if (text !== "" && r?.changed === false) {
        throw vtxError(
          VtxErrorCode.NO_EFFECT,
          `Element ${selector} rejected synthetic paste (contentEditable unchanged; editor may gate on isTrusted — try vortex_fill, or a future trusted-paste escalation)`,
          { selector, extras: { attempted: text } },
        );
      }
      const result = { success: true, pasted: text.length, path: "synthetic-clipboard" };
      return __heal.healed ? { ...result, healed: true } : result;
    },

    [DomActions.FILL]: async (args, tabId) => {
      const __t = resolveTarget(args);
      // let 声明：gate 自愈后用 __heal.selector 重绑，下游所有引用统一用 selector。
      let selector = __t.selector;
      const fallbackToNative = args.fallbackToNative === true;
      const rawValue = args.value;
      if (rawValue == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: value");
      // 非标量 value 拒绝:schema 允许任意 JSON,但对象/数组传到原生 value setter
      // 会被 String 化成 "[object Object]"/"1,2" readback 非空 → 静默写入垃圾报
      // success(2026-06-04 审计 #nv,LIVE 确认)。响亮报错指引;number/boolean 等
      // 标量经 String() 强转为正常字符串下传(原生 setter 本就如此,显式化保证
      // value 永远是 string)。
      if (typeof rawValue === "object") {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `fill value must be a string (or scalar), got ${Array.isArray(rawValue) ? "array" : "object"}`,
        );
      }
      const value = String(rawValue);
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // L2 integration: actionability + descriptor 自愈 gate。
      // needsEditable:true 保持与原 waitActionableAutoForce 调用一致（fill 需可编辑元素）。
      // NOT_STABLE 自动 force 重试(对齐 BUG-011 / CLICK)逻辑在 waitActionableAutoForce 内已覆盖。
      const __healFill = await healAwareGate(
        tid,
        frameId,
        selector,
        { timeout: args.timeout as number | undefined, needsEditable: true },
        args.force as boolean | undefined,
        __t.descriptor,
      );
      // 重绑 selector：若已自愈则改为 healed selector，下游所有引用统一用 selector。
      selector = __healFill.selector;

      // === framework-aware rejection via page-side bundle (@since 0.4.0, migrated T2.7a) ===
      if (!fallbackToNative) {
        await loadPageSideModule(tid, frameId, "fill-reject");
        const rejectResult = await nativePageQuery<
          | { rejected: false }
          | { rejected: true; errorCode: string; error: string; extras: Record<string, unknown> }
          | undefined
        >(
          tid,
          frameId,
          (sel: string, patterns: unknown) =>
            (window as any).__vortexFillReject.checkRejectPattern(sel, patterns),
          [selector, FILL_REJECT_PATTERNS],
        );
        if (rejectResult?.rejected) {
          const r = rejectResult as { rejected: true; errorCode: string; error: string; extras: Record<string, unknown> };
          mapPageError(r, selector);
        }
      }

      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      // dialog arm:fill 操作(input 事件 / React onChange 处理)可能触发同步 confirm,默认 dismiss 防冻屏。
      await armDialogPolicy(tid, frameId, "dismiss", null);
      let res: {
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined;
      try {
      res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string, val: string) => {
          try {
            // === element probes (in sync with CLICK) ===
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLInputElement;
            // 探测 disabled 走门同款 isEnabled(含 aria-disabled),与 CLICK/TYPE 一致(#26)。
            if (!(window as any).__vortexDomResolve.isEnabled(el)) {
              return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            const inView =
              rect.top < window.innerHeight &&
              rect.bottom > 0 &&
              rect.left < window.innerWidth &&
              rect.right > 0;
            if (!inView) {
              return {
                errorCode: "ELEMENT_OFFSCREEN",
                error: `Element ${sel} is outside the viewport`,
              };
            }
            // 元素类型分流:isEditable 门放行的类型(input/textarea/select/
            // contenteditable)比 fill 写值逻辑能正确处理的多。对非 text-like 的元素,
            // 回退 `el.value = val` 要么被原生静默忽略、要么写错属性,伪装成
            // success:true 实则页面无变化(silent false-success)。逐类响亮报错指引正确 action。
            // (2026-06-03 act 原语白盒审计族 B)
            //
            // contenteditable → type(走 CDP Input.insertText 正确驱动)。
            if (el.isContentEditable) {
              return {
                errorCode: "INVALID_TARGET",
                error: `Element ${sel} is contentEditable; use action "type" instead of "fill"`,
              };
            }
            // 原生 <select> → select(fill 设 el.value 仅按 option value 匹配,传可见
            // 文本会被静默忽略并清空选中;SELECT handler 有 value→文本→label 回退)。
            if (el instanceof HTMLSelectElement) {
              return {
                errorCode: "INVALID_TARGET",
                error: `Element ${sel} is a <select>; use action "select" instead of "fill"`,
              };
            }
            // checkbox/radio → click(fill 的原生 value setter 写的是 value 属性即
            // 提交值,不是 checked 状态;勾选/取消勾选要靠 click 切换)。
            if (
              el instanceof HTMLInputElement &&
              (el.type === "checkbox" || el.type === "radio")
            ) {
              return {
                errorCode: "INVALID_TARGET",
                error: `Element ${sel} is a ${el.type}; use action "click" to toggle it instead of "fill"`,
              };
            }
            // === fill operation ===
            // 走原生 value setter 是为绕过 React 受控组件覆盖的 setter,但必须按元素
            // 实际类型取:textarea 用 HTMLTextAreaElement、input 用 HTMLInputElement。
            // 用错类型(如对 <textarea> 调用 HTMLInputElement 的 setter)会触发浏览器
            // 对原生访问器的品牌检查抛 "Illegal invocation"——Bing/Google 搜索框、评论框
            // 等都是 textarea,误用 input setter 会让 fill 对整类失效。
            const valueProto =
              el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : el instanceof HTMLInputElement
                  ? window.HTMLInputElement.prototype
                  : null;
            const nativeValueSetter = valueProto
              ? Object.getOwnPropertyDescriptor(valueProto, "value")?.set
              : undefined;
            if (nativeValueSetter) {
              nativeValueSetter.call(el, val);
            } else {
              el.value = val;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            // 回读校验副作用真发生:type=number/date/email 等对非法格式的值,原生 setter
            // 静默置空(el.value="")。传了非空值却读回空 = 输入被拒,报 NO_EFFECT 而非
            // 假成功(2026-06-03 act 原语白盒审计族 A,#7)。仅判「非空→空」的明确拒绝,
            // 不误伤值规范化(如 number "007"→"7")。
            if (String(val) !== "" && (el as HTMLInputElement).value === "") {
              return {
                errorCode: "NO_EFFECT",
                error: `Element ${sel} rejected value "${String(val)}" (likely a format/type constraint, e.g. type=number/date); value is empty after fill`,
                extras: { attempted: String(val), type: (el as HTMLInputElement).type },
              };
            }
            // DESIGN-002 (N0063): fill 成功后显式 focus,让后续 vortex_press/Enter 落在 input 上。
            // 原生 value setter 不触发 focus,React 受控组件 click→fill 链路常使 activeElement
            // 停在 BODY(实测 bytenew 搜索框 fill 后 activeElement=BODY → 搜索+回车整类失效)。
            // preventScroll 避免 sticky 容器 fill 后视口跳变;不支持该选项的环境兜底裸 focus。
            if (typeof el.focus === "function") {
              try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* focus 非所有元素可用 */ } }
            }
            // focused 反映真实结果(focus 在 disabled/hidden 上不抛错但静默 no-op,review N0063):
            // 取 el 所在 root(穿 shadow)的 activeElement 是否就是 el,而非硬编码 true。
            const __root = (el.getRootNode?.() ?? el.ownerDocument) as Document | ShadowRoot;
            const focused = __root?.activeElement === el;
            return { result: { success: true, focused } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, value],
      );
      } finally {
        await readDialogCapturedAndDisarm(tid, frameId);
      }
      if (res?.error) mapPageError(res, selector);
      const fillResult = res?.result;
      return __healFill.healed ? { ...(fillResult as object), healed: true } : fillResult;
    },

    [DomActions.SELECT]: async (args, tabId) => {
      const __t = resolveTarget(args);
      // let 声明：gate 自愈后用 __heal.selector 重绑，下游所有引用统一用 selector。
      let selector = __t.selector;
      // value 可为单值(string)或数组(string[],原生 <select multiple> 多选)。
      const value = args.value as string | string[];
      if (value == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: value");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // L2 integration: actionability + descriptor 自愈 gate。
      const __healSelect = await healAwareGate(
        tid,
        frameId,
        selector,
        { timeout: args.timeout as number | undefined },
        args.force as boolean | undefined,
        __t.descriptor,
      );
      // 重绑 selector：若已自愈则改为 healed selector，下游所有引用统一用 selector。
      selector = __healSelect.selector;

      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      // dialog arm:select 操作(change 事件)可能触发同步 confirm,默认 dismiss 防冻屏。
      await armDialogPolicy(tid, frameId, "dismiss", null);
      let res: {
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined;
      try {
      res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        async (sel: string, val: string | string[], timeoutMs: number) => {
          try {
            // === 探测（与 CLICK 同步）===
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLSelectElement;
            // 探测 disabled 走门同款 isEnabled(含 aria-disabled),与 CLICK/TYPE/FILL 一致(#26)。
            if (!(window as any).__vortexDomResolve.isEnabled(el)) {
              return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            const inView =
              rect.top < window.innerHeight &&
              rect.bottom > 0 &&
              rect.left < window.innerWidth &&
              rect.right > 0;
            if (!inView) {
              return {
                errorCode: "ELEMENT_OFFSCREEN",
                error: `Element ${sel} is outside the viewport`,
              };
            }
            // === select 操作 ===
            // 原生 <select>:el.value=val 仅按 option 的 value 属性匹配,且选不中时
            // value 静默变 "" / selectedIndex 变 -1。调用方(尤其 agent)常只看得到可见
            // 文本(observe 不枚举 option),故按 value → 可见文本(label) → label 属性
            // 依次回退;全不中则报错而非假成功(2026-06-01 native-select dogfood)。
            let opts = Array.from(el.options);
            const norm = (s: string) => s.replace(/\s+/g, " ").trim();
            const matchOption = (one: string): HTMLOptionElement | null => {
              const t = norm(String(one));
              return (
                opts.find((o) => o.value === one) ??
                opts.find((o) => norm(o.text) === t) ??
                opts.find((o) => o.label != null && norm(o.label) === t) ??
                null
              );
            };

            // 轮询等异步选项渲染:options 被 Ajax/远程填充,首帧可能为空,同步枚举一次
            // 会误报 NO_MATCHING_OPTION(2026-06-03 act 原语白盒审计族 I #23)。el.options
            // 是 live collection,每轮重读即可拾取后插入的 option。common case 首次即全
            // 匹配,不进轮询(零额外开销,与原同步行为一致,低回归风险)。
            const wantList = Array.isArray(val) ? (val as string[]) : [val as string];
            const allMatchable = () => wantList.every((one) => matchOption(one) != null);
            if (!allMatchable()) {
              const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
              const deadline = Date.now() + Math.min(timeoutMs, 4000);
              while (Date.now() < deadline) {
                await sleep(50);
                opts = Array.from(el.options);
                if (allMatchable()) break;
              }
            }

            // 数组 value = 多选(原生 <select multiple>)。单值赋值 el.value 只能选中
            // 一个 option,多选必须逐 option 设 .selected;全中才提交,任一不中报错而非
            // 部分假成功(2026-06-03 多选 dogfood,act 原语白盒审计族 E)。
            if (Array.isArray(val)) {
              if (!el.multiple) {
                return {
                  errorCode: "INVALID_PARAMS",
                  error: `<select> ${sel} is not multiple; pass a single value, not an array`,
                };
              }
              // 去重:数组里两项可能解析到同一 option(如 ["Apple","Apple"],或一个按
              // value、一个按可见文本命中同一项)。不去重则 matched 计数 > selectedOptions
              // 实际选中数,下面回读校验会误报 NO_EFFECT。
              const matched: HTMLOptionElement[] = [];
              const seen = new Set<HTMLOptionElement>();
              const unmatched: string[] = [];
              for (const one of val as string[]) {
                const m = matchOption(one);
                if (!m) {
                  unmatched.push(String(one));
                  continue;
                }
                if (!seen.has(m)) {
                  seen.add(m);
                  matched.push(m);
                }
              }
              if (unmatched.length > 0) {
                return {
                  errorCode: "NO_MATCHING_OPTION",
                  error: `<select> ${sel} has no option matching ${JSON.stringify(unmatched)} (by value or visible text)`,
                  extras: {
                    unmatched,
                    available: opts.map((o) => o.value || o.text).slice(0, 30),
                  },
                };
              }
              // disabled option 可被程序赋值选中(HTML 规范 disabled 只挡用户交互),
              // 选中后回读计数相等会假成功(族 I #21)。命中禁用项直接报错而非假选中。
              const disabledMatched = matched.filter((m) => m.disabled);
              if (disabledMatched.length > 0) {
                return {
                  errorCode: "INVALID_PARAMS",
                  error: `<select> ${sel} option(s) disabled and cannot be selected: ${disabledMatched.map((m) => norm(m.text)).join(", ")}`,
                  extras: { disabled: disabledMatched.map((m) => m.value || m.text) },
                };
              }
              for (const o of opts) o.selected = false;
              for (const m of matched) m.selected = true;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              // 回读校验副作用真发生(disabled option 可能拒绝选中):selectedOptions
              // 必须与意图一致,否则报 NO_EFFECT 而非假成功。
              const selectedNow = Array.from(el.selectedOptions).map((o) => o.value);
              if (selectedNow.length !== matched.length) {
                return {
                  errorCode: "NO_EFFECT",
                  error: `<select> ${sel} multi-select did not fully apply (expected ${matched.length} selected, got ${selectedNow.length}; check for disabled options)`,
                  extras: { selected: selectedNow },
                };
              }
              return { result: { success: true, value: selectedNow } };
            }

            // 单值
            const opt = matchOption(val as string);
            if (!opt) {
              return {
                errorCode: "NO_MATCHING_OPTION",
                error: `<select> ${sel} has no option matching "${String(val)}" (by value or visible text)`,
                extras: {
                  available: opts.map((o) => o.value || o.text).slice(0, 30),
                },
              };
            }
            // disabled option 可被 el.value 程序赋值选中 → 假成功(族 I #21)。明确报错。
            if (opt.disabled) {
              return {
                errorCode: "INVALID_PARAMS",
                error: `<select> ${sel} option "${String(val)}" is disabled and cannot be selected`,
                extras: { disabled: opt.value || opt.text },
              };
            }
            el.value = opt.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            // 回读校验副作用真发生(对齐多选路径 selectedNow 校验):受控/约束 <select>
            // 可能在 change 监听中把选择 snap-back 还原(React 受控拒收、业务约束回弹),
            // el.value 读回 ≠ 意图 = 选择被拒,报 NO_EFFECT 而非假成功(2026-06-20 白盒复现)。
            // option value 是精确值无规范化(不同于 FILL 自由文本的克制空判),严格比对无假阳。
            if (el.value !== opt.value) {
              return {
                errorCode: "NO_EFFECT",
                error: `<select> ${sel} did not retain selection "${String(val)}" (value is "${el.value}" after change; likely a controlled/constrained select reverting)`,
                extras: { intended: opt.value, actual: el.value },
              };
            }
            return { result: { success: true, value: el.value } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, value, (args.timeout as number | undefined) ?? 5000],
      );
      } finally {
        await readDialogCapturedAndDisarm(tid, frameId);
      }
      if (res?.error) mapPageError(res, selector);
      const selectResult = res?.result;
      return __healSelect.healed ? { ...(selectResult as object), healed: true } : selectResult;
    },

    [DomActions.SCROLL]: async (args, tabId) => {
      const __t = resolveTargetOptional(args);
      const selector = __t?.selector;
      const container = args.container as string | undefined;
      const position = args.position as string | undefined;
      const x = args.x as number | undefined;
      const y = args.y as number | undefined;
      if (!selector && !position && x === undefined && y === undefined) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          "Must specify selector/index, position, or x/y coordinates",
        );
      }
      const tid = await getActiveTabId(__t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (
          sel: string | undefined,
          cont: string | undefined,
          pos: string | undefined,
          sx: number | undefined,
          sy: number | undefined,
        ) => {
          try {
            // 找最近 scrollable 祖先：沿 parentElement 链找 overflow:auto|scroll
            // 且 scrollHeight > clientHeight 的元素。modal 内 overflow:auto 容器
            // 是最常见的"卡在 window 不动"场景（P1-5, 2026-05-21）。
            const findScrollableAncestor = (el: Element | null): Element | null => {
              for (let cur: Element | null = el; cur; cur = cur.parentElement) {
                if (cur === document.documentElement || cur === document.body) break;
                const cs = getComputedStyle(cur);
                const overflowY = cs.overflowY;
                const overflowX = cs.overflowX;
                const scrolls = (overflowY === "auto" || overflowY === "scroll" || overflowX === "auto" || overflowX === "scroll");
                if (scrolls && (cur.scrollHeight > cur.clientHeight || cur.scrollWidth > cur.clientWidth)) {
                  return cur;
                }
              }
              return null;
            };

            // 读滚动位置(回读校验副作用:scroll 必须返回是否真滚动,否则到边界/
            // 容器解析错时静默假成功,agent 以为滚到了实际没动 → 后续 act 找不到目标
            // 陷入循环。2026-06-03 act 原语白盒审计族 A,#18/#19)。
            const readPos = (t: Element | Window): { top: number; left: number } =>
              t instanceof Window
                ? { top: t.scrollY, left: t.scrollX }
                : { top: (t as Element).scrollTop, left: (t as Element).scrollLeft };

            // 确定滚动容器
            let scrollTarget: Element | Window = window;
            if (cont) {
              const containerEl = document.querySelector(cont);
              if (!containerEl) return { error: `Container not found: ${cont}` };
              scrollTarget = containerEl;
            }

            // selector + position 组合：滚动 selector 元素的最近 scrollable 祖先
            // 而不是把元素居中（scrollIntoView 对 modal 内 overflow 容器无效，
            // 是用户 P1-5 报告的根因）
            if (sel && pos && !cont) {
              const el = document.querySelector(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              const ancestor = findScrollableAncestor(el);
              if (ancestor) {
                scrollTarget = ancestor;
              }
              // fall through to position branch（scrollTarget 已切换）
            } else if (sel) {
              // 仅 selector（无 position）：scrollIntoView 把元素居中。用 behavior:"auto"
              // (instant)而非 smooth——平滑动画异步,scrollTo 立即返回而滚动未完成,
              // 后续 observe/act 读到中途位置(#19)。回读元素 rect 判断是否真移动 + 是否
              // 已在视口。
              const el = document.querySelector(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              const beforeTop = el.getBoundingClientRect().top;
              el.scrollIntoView({ behavior: "auto", block: "center" });
              const afterRect = el.getBoundingClientRect();
              const inView =
                afterRect.top < window.innerHeight && afterRect.bottom > 0;
              return {
                result: {
                  success: true,
                  moved: Math.abs(afterRect.top - beforeTop) > 1,
                  inView,
                },
              };
            }

            const doScroll = (opts: ScrollToOptions): { success: true; moved: boolean; scrollTop: number; scrollLeft: number } => {
              const before = readPos(scrollTarget);
              const scrollOpts: ScrollToOptions = { ...opts, behavior: "auto" };
              if (scrollTarget instanceof Window) {
                scrollTarget.scrollTo(scrollOpts);
              } else {
                (scrollTarget as Element).scrollTo(scrollOpts);
              }
              const after = readPos(scrollTarget);
              return {
                success: true,
                // 回读:位置无变化(已在目标边界 / 容器不可滚 / 容器解析错)时 moved:false,
                // agent 据此判断是否真滚动而非盲信 success(#18)。
                moved:
                  Math.abs(after.top - before.top) > 1 ||
                  Math.abs(after.left - before.left) > 1,
                scrollTop: after.top,
                scrollLeft: after.left,
              };
            };

            // 根据 position 滚动(behavior:auto instant,#19)
            if (pos) {
              const scrollOpts: ScrollToOptions = {};
              if (pos === "top") { scrollOpts.top = 0; }
              else if (pos === "bottom") { scrollOpts.top = 999999; }
              else if (pos === "left") { scrollOpts.left = 0; }
              else if (pos === "right") { scrollOpts.left = 999999; }
              return { result: doScroll(scrollOpts) };
            }

            // 滚动到指定坐标
            if (sx !== undefined || sy !== undefined) {
              const scrollOpts: ScrollToOptions = {};
              if (sx !== undefined) scrollOpts.left = sx;
              if (sy !== undefined) scrollOpts.top = sy;
              return { result: doScroll(scrollOpts) };
            }

            return { error: "Must specify selector, position, or x/y coordinates" };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector ?? null, container ?? null, position ?? null, x ?? null, y ?? null],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.HOVER]: async (args, tabId) => {
      const __t = resolveTarget(args);
      // let 声明：gate 自愈后用 __heal.selector 重绑，下游所有引用统一用 selector。
      let selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // L2 integration: descriptor 自愈 gate。HOVER 原本不走 actionability 门；
      // 此处加入 healAwareGate 使 stale ref 能重匹配元素后重试。HOVER 不检查
      // disabled，故用 force=true 跳过 actionability 严格门，仅借助 waitActionable
      // 的 NOT_ATTACHED 检测触发自愈路径（与原行为兼容）。
      const __healHover = await healAwareGate(
        tid,
        frameId,
        selector,
        { timeout: args.timeout as number | undefined },
        /* force */ true, // HOVER 原来不走门，用 force:true 保留原有宽松语义
        __t.descriptor,
      );
      // 重绑 selector：若已自愈则改为 healed selector，下游所有引用统一用 selector。
      selector = __healHover.selector;

      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      // dialog arm:hover 操作(mouseover/mouseenter + CDP mouseMoved)可能触发同步 confirm,默认 dismiss 防冻屏。
      await armDialogPolicy(tid, frameId, "dismiss", null);
      try {
      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string) => {
          try {
            // === 探测（与 CLICK 同步；HOVER 不检查 disabled，disabled 元素仍可收 hover 事件）===
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLElement;
            // 滚入视口:真鼠标(下面 CDP mouseMoved)只能移到视口内坐标,离屏元素
            // hover 无效。滚动后再取 rect 算中心(2026-06-03 act 原语白盒审计族 C)。
            el.scrollIntoView({ block: "center", inline: "center" });
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // === hover 操作(合成事件回退)===
            // 合成事件供监听 page-side mouseover 的库即时反应;真实 CSS :hover 态由
            // handler 侧的 CDP mouseMoved 触发(合成 JS 事件不更新浏览器 hover 态)。
            // mouseenter 规范上不冒泡,用 bubbles:false 修正语义。
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true }));
            // 静态 tooltip 信息：CSS `title` 的 OS 级 tooltip 不依赖 JS 事件
            // 触发（需要鼠标在元素上真停留），JS 无法可靠等到。所以直接读
            // 元素的 tooltip 相关属性返回，调用方不再依赖 DOM 渲染（P2-8,
            // 2026-05-21）。
            const tooltipInfo: Record<string, string> = {};
            const title = el.getAttribute("title");
            if (title) tooltipInfo.title = title;
            const ariaLabel = el.getAttribute("aria-label");
            if (ariaLabel) tooltipInfo.ariaLabel = ariaLabel;
            const ariaDescribedBy = el.getAttribute("aria-describedby");
            if (ariaDescribedBy) {
              tooltipInfo.ariaDescribedBy = ariaDescribedBy;
              const desc = document.getElementById(ariaDescribedBy);
              if (desc) {
                const t = (desc.textContent || "").replace(/\s+/g, " ").trim();
                if (t) tooltipInfo.ariaDescription = t.slice(0, 200);
              }
            }
            const dataTooltip = el.getAttribute("data-tooltip") || el.getAttribute("data-original-title");
            if (dataTooltip) tooltipInfo.dataTooltip = dataTooltip;
            return { result: { cx, cy, tooltip: tooltipInfo } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector],
      );
      if (res?.error) mapPageError(res, selector);
      const hr = res?.result as
        | { cx: number; cy: number; tooltip: Record<string, string> }
        | undefined;
      // CDP 真鼠标移到元素中心:更新浏览器 hover 态,触发 CSS :hover + 原生
      // pointerover/mousemove/mouseover——合成 JS 事件无法触发 CSS :hover,纯 CSS
      // 悬停菜单/tooltip 因此永不展开(2026-06-03 act 原语白盒审计族 C,P0)。
      if (hr) {
        const { x: ox, y: oy } = await getIframeOffset(tid, frameId);
        await debuggerMgr.attach(tid);
        await debuggerMgr.sendCommand(tid, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: hr.cx + ox,
          y: hr.cy + oy,
        });
      }
      const hoverResult = { success: true, ...(hr?.tooltip ?? {}) };
      return __healHover.healed ? { ...hoverResult, healed: true } : hoverResult;
      } finally {
        await readDialogCapturedAndDisarm(tid, frameId);
      }
    },

    [DomActions.GET_ATTRIBUTE]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const attribute = args.attribute as string;
      if (!attribute) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: attribute");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string, attr: string) => {
          try {
            const el = document.querySelector(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            return { result: el.getAttribute(attr) };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, attribute],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.GET_SCROLL_INFO]: async (args, tabId) => {
      const __t = resolveTargetOptional(args);
      const selector = __t?.selector;
      const tid = await getActiveTabId(__t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string | undefined) => {
          try {
            if (sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              return {
                result: {
                  scrollTop: el.scrollTop,
                  scrollLeft: el.scrollLeft,
                  scrollHeight: el.scrollHeight,
                  scrollWidth: el.scrollWidth,
                  clientHeight: el.clientHeight,
                  clientWidth: el.clientWidth,
                },
              };
            }
            return {
              result: {
                scrollTop: window.scrollY,
                scrollLeft: window.scrollX,
                scrollHeight: document.documentElement.scrollHeight,
                scrollWidth: document.documentElement.scrollWidth,
                clientHeight: document.documentElement.clientHeight,
                clientWidth: document.documentElement.clientWidth,
              },
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector ?? null],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.WAIT_FOR_MUTATION]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const timeout = (args.timeout as number | undefined) ?? 10000;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string, timeoutMs: number) => {
          return new Promise<{ result?: unknown; error?: string }>((resolve) => {
            try {
              const el = document.querySelector(sel);
              if (!el) {
                resolve({ error: `Element not found: ${sel}` });
                return;
              }
              let settled = false;
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                observer.disconnect();
                resolve({ result: { mutated: false } });
              }, timeoutMs);

              const observer = new MutationObserver(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                observer.disconnect();
                resolve({ result: { mutated: true } });
              });

              observer.observe(el, { childList: true, subtree: true });
            } catch (err) {
              resolve({ error: err instanceof Error ? err.message : String(err) });
            }
          });
        },
        [selector, timeout],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.WAIT_SETTLED]: async (args, tabId) => {
      // selector 可选；无 selector 时监视 document.body 整棵
      const __t = resolveTargetOptional(args);
      const selector = __t?.selector;
      const quietMs = (args.quietMs as number | undefined) ?? 300;
      const timeout = (args.timeout as number | undefined) ?? 8000;
      const tid = await getActiveTabId(
        __t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId,
      );
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string | null, quiet: number, to: number) => {
          return new Promise<{ result?: unknown; error?: string }>((resolve) => {
            try {
              const root = sel ? document.querySelector(sel) : document.body;
              if (!root) {
                resolve({ error: sel ? `Element not found: ${sel}` : "document.body not found" });
                return;
              }
              const start = Date.now();
              let settled = false;
              let quietTimer: ReturnType<typeof setTimeout> | null = null;
              let mutationsSeen = 0;

              const timeoutTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                obs.disconnect();
                if (quietTimer) clearTimeout(quietTimer);
                resolve({
                  error: `DOM did not settle within ${to}ms (${mutationsSeen} mutations observed)`,
                  // 标识 TIMEOUT，便于 handler 分类
                  // 约定：以 "DOM did not settle" 开头 → TIMEOUT
                });
              }, to);

              const startQuiet = () => {
                if (quietTimer) clearTimeout(quietTimer);
                quietTimer = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  obs.disconnect();
                  clearTimeout(timeoutTimer);
                  resolve({
                    result: {
                      settled: true,
                      waitedMs: Date.now() - start,
                      mutationsSeen,
                    },
                  });
                }, quiet);
              };

              const obs = new MutationObserver(() => {
                mutationsSeen++;
                startQuiet();
              });
              obs.observe(root, { childList: true, subtree: true, attributes: true });
              // 立即开 quiet 窗口（"已经静止"情况下直接到期 resolve）
              startQuiet();
            } catch (err) {
              resolve({ error: err instanceof Error ? err.message : String(err) });
            }
          });
        },
        [selector ?? null, quietMs, timeout],
      );
      if (res?.error) {
        const isTimeout = res.error.startsWith("DOM did not settle");
        const isNotFound =
          res.error.startsWith("Element not found:") ||
          res.error.startsWith("document.body not found");
        const code = isTimeout
          ? VtxErrorCode.TIMEOUT
          : isNotFound
            ? VtxErrorCode.ELEMENT_NOT_FOUND
            : VtxErrorCode.JS_EXECUTION_ERROR;
        throw vtxError(code, res.error, selector ? { selector } : undefined);
      }
      return res?.result;
    },

    [DomActions.COMMIT]: async (args, tabId) => {
      const kind = args.kind as CommitKind | undefined;
      const value = args.value as unknown;
      const timeout = (args.timeout as number | undefined) ?? 8000;
      if (!kind) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: kind");
      if (value == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: value");
      const driver = findDriver(kind);
      if (!driver) {
        const known = COMMIT_DRIVERS.map((d) => d.kind);
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `No commit driver for kind=${kind}. Known: ${known.join(", ")}`,
        );
      }

      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // daterange/datetimerange 走 CDP 真鼠标路径：dispatchMouseEvent 是 untrusted,
      // Element Plus 某些 handler 检查 isTrusted 后不同步 v-model。
      if (driver.kind === "daterange" || driver.kind === "datetimerange") {
        return await runDateRangeDriverCDP({
          tid,
          frameId,
          selector,
          closestSelector: driver.closestSelector,
          isDateTime: driver.kind === "datetimerange",
          value: value as { start?: string; end?: string },
          timeout,
          debuggerMgr,
        });
      }

      // cascader 也走 CDP：trigger 对 JS .click() 不响应，但 panel 内 node labels
      // 用 page-side .click() 可以逐级展开，混合路径省一堆 CDP 往返。
      if (driver.kind === "cascader") {
        return await runCascaderDriverCDP({
          tid,
          frameId,
          selector,
          closestSelector: driver.closestSelector,
          value: value as unknown[],
          timeout,
          debuggerMgr,
        });
      }

      // time picker：CDP 打开 panel + 三列 spinner click + 点 OK
      if (driver.kind === "time") {
        return await runTimePickerDriverCDP({
          tid,
          frameId,
          selector,
          closestSelector: driver.closestSelector,
          value: String(value),
          timeout,
          debuggerMgr,
        });
      }

      // Load page-side bundle for drivers that have been migrated out of inline func.
      if (driver.kind === "checkbox-group") {
        await loadPageSideModule(tid, frameId, "commit-checkbox-group");
      } else if (driver.kind === "select") {
        // kind="select" 是「select-like 控件」统一入口:不再独占绑定 Element Plus。
        // 同时加载 EP 专用 driver 与通用 ARIA driver,page-side 按要素结构二段路由
        // (DEF-006:Headless UI / MUI / Radix / antd / react-select 等非 EP 的
        // combobox/listbox 此前必须显式 kind="aria-select" 才能命中,代理凭直觉用
        // kind="select" 100% UNSUPPORTED_TARGET)。
        await loadPageSideModule(tid, frameId, "commit-select");
        await loadPageSideModule(tid, frameId, "commit-aria-select");
      } else if (driver.kind === "aria-select") {
        await loadPageSideModule(tid, frameId, "commit-aria-select");
      }

      // 通用 ARIA driver 的 closestSelector:kind="select" 二段路由的 EP 未命中回退用。
      const ariaClosestSelector =
        findDriver("aria-select")?.closestSelector ??
        '[role="combobox"], [aria-haspopup="listbox"], [role="listbox"]';

      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        stage?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (
          sel: string,
          closestSelector: string,
          ariaClosest: string,
          val: unknown,
          timeoutMs: number,
          driverId: string,
        ) => {
          const w = window as any;
          if (driverId === "element-plus-checkbox-group") {
            return w.__vortexCommitCheckboxGroup.run(sel, closestSelector, val, timeoutMs);
          }
          if (driverId === "generic-aria-select") {
            return w.__vortexCommitAriaSelect.run(sel, ariaClosest, val, timeoutMs);
          }
          if (driverId === "element-plus-select") {
            // kind="select" 二段路由:先认 Element Plus el-select(其专属 driver 处理
            // filterable 虚拟列表等 EP 特有交互),否则回退通用 ARIA combobox/listbox
            // driver。原生 <select> 不属任一组件 driver,明确指引改用 action "select"。
            const els = document.querySelectorAll(sel);
            if (els.length === 0)
              return { error: `Element not found: ${sel}`, errorCode: "ELEMENT_NOT_FOUND" };
            if (els.length > 1)
              return {
                error: `Selector "${sel}" matched ${els.length} elements`,
                errorCode: "SELECTOR_AMBIGUOUS",
                extras: { matchCount: els.length },
              };
            const target = els[0] as HTMLElement;
            if (target.closest(closestSelector) || target.querySelector(closestSelector)) {
              return w.__vortexCommitSelect.run(sel, closestSelector, val, timeoutMs);
            }
            if (target.tagName === "SELECT" || target.closest("select")) {
              return {
                error: `Target is a native <select>; kind="select" is for component-library widgets (Element Plus / Headless UI / MUI / Radix / antd …). Use action "select" (vortex_act) or vortex_fill_form without kind.`,
                errorCode: "UNSUPPORTED_TARGET",
                extras: { driverId: "element-plus-select", nativeSelect: true },
              };
            }
            return w.__vortexCommitAriaSelect.run(sel, ariaClosest, val, timeoutMs);
          }
          return { error: `Unknown driver id: ${driverId}`, errorCode: "INVALID_PARAMS" };
        },
        [selector, driver.closestSelector, ariaClosestSelector, value as never, timeout, driver.id],
      );

      if (res?.error) {
        const known = res.errorCode && res.errorCode in VtxErrorCode;
        const code = known ? (res.errorCode as VtxErrorCode) : VtxErrorCode.JS_EXECUTION_ERROR;
        const extras: Record<string, unknown> = { ...(res.extras ?? {}), driverId: driver.id };
        if (res.stage) extras.stage = res.stage;
        throw vtxError(code, res.error, { selector, extras });
      }
      return res?.result;
    },
  });
}
