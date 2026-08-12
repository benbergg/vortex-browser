// L1 CDP Adapter：chrome.debugger.* 包装。
// 不被 L2/L3/L4 import（depcruise 强制；见 .dependency-cruiser.cjs）。
// PR #1 各 task 逐步迁入：clickBBox / cdpClickElement / 3 个 CDP driver。

import { getIframeOffset } from "../lib/iframe-offset.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { pageQuery as nativePageQuery, mapPageError } from "./native.js";
import type { ClickEffect } from "../page-side/click-effect.js";
import { buildExecuteTarget } from "../lib/tab-utils.js";

// dialog 应答策略 arm/read 共享 helper(与 dom.ts 版本同源,因 cdp.ts 不能 import dom.ts 而本地重复)。
async function armDialogPolicyCdp(
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

async function readDialogCapturedAndDisarmCdp(
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
 * CDP 真鼠标 click at page-coords (x, y)。
 * 抽取自 dom.ts 3 处重复（runDateRangeDriverCDP / runCascaderDriverCDP / runTimePickerDriverCDP）。
 * CLICK handler useRealMouse 分支 inline 版本将在 T1.9（cdpClickElement 抽取）一并合并复用。
 *
 * 注：调用方负责把 viewport-coords + iframe offset 加为 page-coords 后传入。
 * 这样设计避免本函数内部隐式调用 getIframeOffset，cdpClickElement 可以提前算 1 次复用。
 *
 * debuggerMgr 显式参数（cdp.ts 内不持有状态，见 §0.2 约束 #1）。
 */
export async function clickBBox(
  debuggerMgr: DebuggerManager,
  tabId: number,
  x: number,
  y: number,
): Promise<void> {
  await debuggerMgr.attach(tabId);
  await debuggerMgr.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await debuggerMgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await debuggerMgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
}

/**
 * useRealMouse click：page-side 探测元素中心点 → CDP 真鼠标三连击。
 * 抽取自 dom.ts CLICK handler useRealMouse 分支（v0.5.0 spec L99-205 区域）。
 * 注：page-side func 字面量保留在本函数体内，不能引用外部模块（chrome.scripting 序列化限制）。
 *
 * scripting world: MAIN（page-side actionability 探测）。
 * debuggerMgr 显式参数（cdp.ts 内不持有状态，见 §0.2 约束 #1）。
 */
export async function cdpClickElement(
  debuggerMgr: DebuggerManager,
  tabId: number,
  frameId: number | undefined,
  selector: string,
  // force=true skips occlusion check (ELEMENT_OCCLUDED only); disabled/detached/not_found/ambiguous still apply
  // observeEffect: GAP-G(N0062) 效果信号采集，需 caller 预注入 click-effect 模块；opt-in，默认关
  // onDialog/promptText: dialog 应答策略，arm 后 CDP 点击触发的 confirm/prompt 按此策略应答
  options: { force?: boolean; observeEffect?: boolean; windowMs?: number; onDialog?: string; promptText?: string | null } = {},
): Promise<{
  success: true;
  element: { tag: string; text?: string };
  x: number;
  y: number;
  mode: "realMouse";
  effect?: ClickEffect;
  dialogs?: Array<{ type: string; message: string }>;
}> {
  const { force = false, observeEffect = false, windowMs, onDialog, promptText } = options;
  // page-side 探测（与原 dom.ts useRealMouse 分支 L106-169 完全一致，逐行复制 func 字面量）
  const rectRes = await nativePageQuery<{
    result?: { x: number; y: number; tag: string; text?: string };
    error?: string;
    errorCode?: string;
    extras?: Record<string, unknown>;
  }>(
    tabId,
    frameId,
    (sel: string, force: boolean) => {
      try {
        // === 探测 ===
        // 与门(dom.ts CLICK 同步路径)一致:经 __vortexDomResolve.queryAllDeep 穿 open
        // shadow,而非旧 light-DOM querySelectorAll——否则 shadow-internal ref 在此假阴
        // ELEMENT_NOT_FOUND,门却能解析,两路不一致(#14)。caller 已预加载 dom-resolve;
        // 万一未就绪(注入失败)回退 light-DOM,不崩。
        const resolve = (window as any).__vortexDomResolve;
        const els: Element[] = resolve
          ? (resolve.queryAllDeep(sel) as Element[])
          : Array.from(document.querySelectorAll(sel));
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
        // disabled 判定走门同款 isEnabled(含 aria-disabled),旧版只判 .disabled(#29)。
        const enabled = resolve
          ? resolve.isEnabled(el)
          : (el as HTMLInputElement).disabled !== true;
        if (!enabled) {
          return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
        }
        const rect0 = el.getBoundingClientRect();
        if (rect0.width === 0 || rect0.height === 0) {
          return {
            errorCode: "ELEMENT_DETACHED",
            error: `Element ${sel} has zero dimensions (detached or hidden)`,
          };
        }
        // 元素已完全在视口内 → 跳过 scrollIntoView。无谓的 block:center 会把已可点
        // 元素强行滚到几何中心,在「内部 overflow/transform 容器 + JS 监听并弹回」的
        // 动态画布(React Flow 等)上触发容器临时滚动:act 同步缓存坐标后容器 ~50ms
        // 弹回,CDP 异步 dispatchMouse 时坐标已失效 → 点中相邻元素(2026-06-14
        // reactflow.dev dogfood B2:pyramid radio 被点成 cube)。仅当元素未完全可见才
        // 滚动(此时滚动必要),保留居中避遮挡;视口内被遮挡由下方 occlusion 检查兜底。
        // 同源守卫见 dom.ts CLICK 同步路径(注入闭包不能引模块级 helper);mouse.ts drag
        // 用 scrollIntoView({block:"nearest"})对完全可见元素天然不滚,无需此守卫。
        // 已知 trade-off:完全可见但被 sticky/fixed 居中遮挡的元素,旧 block:center 会滚到
        // 中心脱离遮挡,跳过后可能命中下方 occlusion 检查报 ELEMENT_OCCLUDED——可接受,因
        // loud 的 OCCLUDED 报错优于 silent 点错相邻元素,caller 可 force=true 兜底。
        const __vw = window.innerWidth, __vh = window.innerHeight;
        const __fullyInView =
          rect0.top >= 0 && rect0.left >= 0 &&
          rect0.bottom <= __vh && rect0.right <= __vw;
        if (!__fullyInView) {
          el.scrollIntoView({ block: "center", inline: "center" });
        }
        const rect = el.getBoundingClientRect();
        const cxInner = rect.left + rect.width / 2;
        const cyInner = rect.top + rect.height / 2;
        // occlusion 检查:用穿 shadow 的 deepElementFromPoint,与门一致——对 shadow-internal
        // 元素 document.elementFromPoint 返回 shadow host 会误判 ELEMENT_OCCLUDED(#14)。
        const topEl = resolve
          ? (resolve.deepElementFromPoint(cxInner, cyInner) as Element | null)
          : document.elementFromPoint(cxInner, cyInner);
        // 复合输入控件(Element Plus el-select 等)把可见显示层(placeholder /
        // selected-item)作为兄弟节点叠在透明真控件之上。hit-test 命中显示层兄弟——
        // 既非 target 也非其后代——但它非交互且与 target 同处一个交互 widget 容器
        // (el 的最近交互祖先 contains hit),点击经显示层冒泡仍到达控件,非真遮挡。
        // 与 actionability.ts receivesEvents 的 carve-out 同源(2026-06-01 el-select dogfood)。
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
        if (!force) {
          // composedContains 穿 shadow:topEl 落在 target 自身 shadow root 内(sl-option 等
          // 自带 shadow + slotted label 的叶子控件)时,light-DOM el.contains(topEl) 恒 false
          // → 误判 ELEMENT_OCCLUDED。优先用 resolve(__vortexDomResolve)暴露的穿 shadow 判定。
          const targetContainsHit = !topEl
            ? false
            : resolve?.composedContains
              ? resolve.composedContains(el, topEl)
              : el.contains(topEl);
          if (
            topEl &&
            topEl !== el &&
            !targetContainsHit &&
            !topEl.contains(el) &&
            !sameWidgetDecoration
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
        }
        return {
          result: {
            x: cxInner,
            y: cyInner,
            tag: el.tagName.toLowerCase(),
            text: el.innerText?.slice(0, 200),
          },
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    [selector, force],
  );

  if (rectRes?.error) mapPageError(rectRes, selector);

  const { x: cx, y: cy, tag, text } = rectRes.result!;
  // 提前算 1 次 iframe offset，给 dispatch + return 共用（避免两次 round-trip + race）
  // 传 debuggerMgr 启用 CDP 兜底：DOM 够不到 shadow 内嵌 iframe 时(如 oopif-in-csr
  // 跨源 iframe ⊂ closed shadow)经 CDP 穿 shadow 拿 offset，否则 realMouse 点空。
  const { x: ox, y: oy } = await getIframeOffset(tabId, frameId, debuggerMgr);
  const px = cx + ox;
  const py = cy + oy;

  // GAP-G(N0062): 派发前启动效果信号采集。begin/end 是 clickBBox 前后两次独立 pageQuery,
  // observer 实例存 window.__vortexClickEffect._pending[token] 跨两次调用存活,正好覆盖
  // CDP 派发期间 + windowMs 窗口的 mutation。caller(dom.ts)已预注入 click-effect 模块;
  // 万一未就绪(__vortexClickEffect undefined)则 token 为空,end 拿 observed:false 不崩。
  let effectToken: string | undefined;
  if (observeEffect) {
    effectToken = await nativePageQuery<string | undefined>(
      tabId,
      frameId,
      (sel: string, w: number) => {
        const ce = (window as unknown as {
          __vortexClickEffect?: { begin(s: string, w: number): string };
        }).__vortexClickEffect;
        return ce ? ce.begin(sel, w) : undefined;
      },
      [selector, windowMs ?? 300],
    );
  }

  // dialog arm:CDP 真鼠标点击可能同步触发 confirm/alert/prompt,arm 后 override 据此抑制 + 应答。
  const dlgAnswer = onDialog === "accept" ? "accept" : "dismiss";
  await armDialogPolicyCdp(tabId, frameId, dlgAnswer, promptText ?? null);
  let dialogs: Array<{ type: string; message: string }> = [];
  try {
    // CDP 真鼠标三连击（已 page-coords，clickBBox 内部不再算 offset）
    await clickBBox(debuggerMgr, tabId, px, py);

    let effect: ClickEffect | undefined;
    if (observeEffect && effectToken) {
      effect = await nativePageQuery<ClickEffect | undefined>(
        tabId,
        frameId,
        (token: string) => {
          const ce = (window as unknown as {
            __vortexClickEffect?: { end(t: string): Promise<ClickEffect> };
          }).__vortexClickEffect;
          return ce ? ce.end(token) : undefined;
        },
        [effectToken],
      );
    }

    // 读 dialog captured + grace disarm(在 finally 之前读,确保 dialogs 变量已赋值后再返回)
    dialogs = await readDialogCapturedAndDisarmCdp(tabId, frameId);

    // 返回的 x/y 是 page-coords（含 iframe offset），与原 dom.ts L189-190 一致
    return {
      success: true as const,
      element: { tag, text },
      x: px,
      y: py,
      mode: "realMouse" as const,
      ...(effect ? { effect } : {}),
      ...(dialogs.length ? { dialogs } : {}),
    };
  } catch (err) {
    // 即便 click 抛错也 disarm(guard against page-freeze)
    try { await readDialogCapturedAndDisarmCdp(tabId, frameId); } catch { /* ignore */ }
    throw err;
  }
}
