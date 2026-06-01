// L1 CDP Adapter：chrome.debugger.* 包装。
// 不被 L2/L3/L4 import（depcruise 强制；见 .dependency-cruiser.cjs）。
// PR #1 各 task 逐步迁入：clickBBox / cdpClickElement / 3 个 CDP driver。

import { getIframeOffset } from "../lib/iframe-offset.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { pageQuery as nativePageQuery, mapPageError } from "./native.js";

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
): Promise<{
  success: true;
  element: { tag: string; text?: string };
  x: number;
  y: number;
  mode: "realMouse";
}> {
  // page-side 探测（与原 dom.ts useRealMouse 分支 L106-169 完全一致，逐行复制 func 字面量）
  const rectRes = await nativePageQuery<{
    result?: { x: number; y: number; tag: string; text?: string };
    error?: string;
    errorCode?: string;
    extras?: Record<string, unknown>;
  }>(
    tabId,
    frameId,
    (sel: string) => {
      try {
        // === 探测 ===
        const els = document.querySelectorAll(sel);
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
        if ((el as HTMLInputElement).disabled === true) {
          return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
        }
        const rect0 = el.getBoundingClientRect();
        if (rect0.width === 0 || rect0.height === 0) {
          return {
            errorCode: "ELEMENT_DETACHED",
            error: `Element ${sel} has zero dimensions (detached or hidden)`,
          };
        }
        // useRealMouse 会 scrollIntoView，所以不做 offscreen 检查
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        const cxInner = rect.left + rect.width / 2;
        const cyInner = rect.top + rect.height / 2;
        // occlusion 检查
        const topEl = document.elementFromPoint(cxInner, cyInner);
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
        if (
          topEl &&
          topEl !== el &&
          !el.contains(topEl) &&
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
    [selector],
  );

  if (rectRes?.error) mapPageError(rectRes, selector);

  const { x: cx, y: cy, tag, text } = rectRes.result!;
  // 提前算 1 次 iframe offset，给 dispatch + return 共用（避免两次 round-trip + race）
  const { x: ox, y: oy } = await getIframeOffset(tabId, frameId);
  const px = cx + ox;
  const py = cy + oy;
  // CDP 真鼠标三连击（已 page-coords，clickBBox 内部不再算 offset）
  await clickBBox(debuggerMgr, tabId, px, py);

  // 返回的 x/y 是 page-coords（含 iframe offset），与原 dom.ts L189-190 一致
  return {
    success: true as const,
    element: { tag, text },
    x: px,
    y: py,
    mode: "realMouse" as const,
  };
}
