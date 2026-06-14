import { MouseActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId, ensureFrameAttached, buildExecuteTarget } from "../lib/tab-utils.js";
import { getIframeOffset } from "../lib/iframe-offset.js";
import { resolveTarget } from "../lib/resolve-target.js";
import { waitActionable } from "../action/auto-wait.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";

type CoordSpace = "frame" | "viewport";

async function dispatchMouse(
  debuggerMgr: DebuggerManager,
  tabId: number,
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
  clickCount: number = 1,
  // CDP 按下按钮位掩码(1=左 2=右 4=中)。drag 期间的 mouseMoved 必须带 buttons:1,
  // 否则被当 hover 而非 drag-move → HTML5 DnD / 鼠标拖拽库的 dragstart/dragover/drop
  // 永不 engage(2026-06-04 审计 #3)。click/move 等 hover 场景保持默认 0。
  buttons: number = 0,
): Promise<void> {
  await debuggerMgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    clickCount,
    buttons,
  });
}

/**
 * 把 frame 相对坐标换算为视口坐标。
 * 未传 frameId 或 coordSpace=viewport 时直接返回原值。
 */
async function toViewportCoords(
  tabId: number,
  x: number,
  y: number,
  frameId: number | undefined,
  coordSpace: CoordSpace,
): Promise<{ x: number; y: number; offsetApplied: { x: number; y: number } }> {
  if (coordSpace === "viewport" || frameId == null || frameId === 0) {
    return { x, y, offsetApplied: { x: 0, y: 0 } };
  }
  const offset = await getIframeOffset(tabId, frameId);
  return { x: x + offset.x, y: y + offset.y, offsetApplied: offset };
}

function resolveCoordSpace(
  raw: unknown,
  frameId: number | undefined,
): CoordSpace {
  if (raw === "frame" || raw === "viewport") return raw;
  return frameId != null && frameId !== 0 ? "frame" : "viewport";
}

export function registerMouseHandlers(
  router: ActionRouter,
  debuggerMgr: DebuggerManager,
): void {
  router.registerAll({
    [MouseActions.CLICK]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null && frameId !== 0) await ensureFrameAttached(tid, frameId);
      const coordSpace = resolveCoordSpace(args.coordSpace, frameId);
      const button = (args.button as "left" | "right" | "middle") ?? "left";
      const xIn = args.x as number;
      const yIn = args.y as number;
      if (xIn == null || yIn == null)
        throw vtxError(VtxErrorCode.INVALID_PARAMS, "x and y are required");

      const { x, y, offsetApplied } = await toViewportCoords(
        tid,
        xIn,
        yIn,
        frameId,
        coordSpace,
      );

      await debuggerMgr.attach(tid);
      await dispatchMouse(debuggerMgr, tid, "mouseMoved", x, y, button);
      await dispatchMouse(debuggerMgr, tid, "mousePressed", x, y, button, 1);
      await dispatchMouse(debuggerMgr, tid, "mouseReleased", x, y, button, 1);

      return {
        success: true,
        x,
        y,
        button,
        coordSpace,
        frameId: frameId ?? null,
        offsetApplied,
      };
    },

    [MouseActions.DOUBLE_CLICK]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null && frameId !== 0) await ensureFrameAttached(tid, frameId);
      const coordSpace = resolveCoordSpace(args.coordSpace, frameId);
      const xIn = args.x as number;
      const yIn = args.y as number;
      if (xIn == null || yIn == null)
        throw vtxError(VtxErrorCode.INVALID_PARAMS, "x and y are required");

      const { x, y, offsetApplied } = await toViewportCoords(
        tid,
        xIn,
        yIn,
        frameId,
        coordSpace,
      );

      await debuggerMgr.attach(tid);
      await dispatchMouse(debuggerMgr, tid, "mouseMoved", x, y);
      await dispatchMouse(debuggerMgr, tid, "mousePressed", x, y, "left", 1);
      await dispatchMouse(debuggerMgr, tid, "mouseReleased", x, y, "left", 1);
      await dispatchMouse(debuggerMgr, tid, "mousePressed", x, y, "left", 2);
      await dispatchMouse(debuggerMgr, tid, "mouseReleased", x, y, "left", 2);

      return {
        success: true,
        x,
        y,
        coordSpace,
        frameId: frameId ?? null,
        offsetApplied,
      };
    },

    [MouseActions.DRAG]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null && frameId !== 0) await ensureFrameAttached(tid, frameId);
      const coordSpace = resolveCoordSpace(args.coordSpace, frameId);
      const x1In = args.fromX as number;
      const y1In = args.fromY as number;
      const x2In = args.toX as number;
      const y2In = args.toY as number;
      const steps = (args.steps as number | undefined) ?? 10;
      if (x1In == null || y1In == null || x2In == null || y2In == null)
        throw vtxError(VtxErrorCode.INVALID_PARAMS, "fromX/fromY/toX/toY are required");

      const from = await toViewportCoords(tid, x1In, y1In, frameId, coordSpace);
      const to = await toViewportCoords(tid, x2In, y2In, frameId, coordSpace);

      await debuggerMgr.attach(tid);
      // 1. hover 到起点(buttons=0) 2. press(左键按下,buttons=1)
      // 3. 分 steps 次 drag-move 到终点(按住,buttons=1) 4. release(松开,buttons=0)。
      // drag-move 的 buttons:1 是 HTML5 DnD / 拖拽库识别为拖拽(而非 hover)的关键。
      await dispatchMouse(debuggerMgr, tid, "mouseMoved", from.x, from.y);
      await dispatchMouse(debuggerMgr, tid, "mousePressed", from.x, from.y, "left", 1, 1);
      // BUG-007: 允许 caller 显式 opt-in 慢速 path(DnD 库兼容),默认 0(快速 path)。
      const stepDelay = (args.stepDelay as number | undefined) ?? 0;
      const stepPoint = (i: number) => {
        const t = i / steps;
        return {
          xi: from.x + (to.x - from.x) * t,
          yi: from.y + (to.y - from.y) * t,
        };
      };
      if (stepDelay > 0) {
        // 慢路径:逐步串行 + 显式停顿,给 DnD 库时间 engage dragover/drop。
        for (let i = 1; i <= steps; i++) {
          const { xi, yi } = stepPoint(i);
          await dispatchMouse(debuggerMgr, tid, "mouseMoved", xi, yi, "left", 1, 1);
          await new Promise((r) => setTimeout(r, stepDelay));
        }
      } else {
        // 快路径(BUG-007 根因修复):中间 move 流水线化,而非逐个 await round-trip。
        // 串行时 steps=30+ 的 N×RTT 在真 Chrome 上累计撞 30s mcp timeout;CDP 单 session
        // 按 sendCommand 发起顺序保序处理 Input 事件,故同步发起 N 条再一次性 await
        // 把墙钟从 N×RTT 压到 ~1×RTT,轨迹顺序不变。任一条 reject → Promise.all 整体
        // reject(与串行抛错同义,优雅失败而非静默)。
        const moves: Promise<void>[] = [];
        for (let i = 1; i <= steps; i++) {
          const { xi, yi } = stepPoint(i);
          moves.push(dispatchMouse(debuggerMgr, tid, "mouseMoved", xi, yi, "left", 1, 1));
        }
        await Promise.all(moves);
      }
      await dispatchMouse(debuggerMgr, tid, "mouseReleased", to.x, to.y, "left", 1, 0);

      return {
        success: true,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        steps,
        coordSpace,
        frameId: frameId ?? null,
      };
    },

    // ── vortex_drag: 元素级 DnD ────────────────────────────────────────────
    // 两个 ref→selector 各取 getBoundingClientRect 中心，走 CDP trusted pointer 序列。
    // actionability: start=visible+enabled，end=visible(只需可见作落点)。
    // 教训(memory vortex_0006): 必须用 getBoundingClientRect 拿真实视口坐标，非 transform。
    [MouseActions.DRAG_ELEMENT]: async (args, tabId) => {
      const startTarget = resolveTarget({
        selector: args.startSelector,
        index: args.startIndex,
        snapshotId: args.startSnapshotId,
      });
      const endTarget = resolveTarget({
        selector: args.endSelector,
        index: args.endIndex,
        snapshotId: args.endSnapshotId,
      });

      const tid = await getActiveTabId(
        startTarget.boundTabId ?? (args.tabId as number | undefined) ?? tabId,
      );
      const startFrameId = startTarget.boundFrameId ?? (args.frameId as number | undefined);
      const endFrameId = endTarget.boundFrameId ?? (args.frameId as number | undefined);

      if (startFrameId != null && startFrameId !== 0) await ensureFrameAttached(tid, startFrameId);
      if (endFrameId != null && endFrameId !== 0 && endFrameId !== startFrameId) {
        await ensureFrameAttached(tid, endFrameId);
      }

      // actionability 门 ─ start: visible+enabled（完整门）。
      // waitActionable 返回 rect，但我们之后还要取 scrollIntoView 后的真实 bbox，
      // 所以此处只过门，不复用 rect（避免滚动后坐标漂移）。
      await waitActionable(tid, startFrameId, startTarget.selector, {
        timeout: args.timeout as number | undefined,
      });
      // actionability 门 ─ end: 只要可见（不要求 enabled/editable，只是落点）。
      // 复用 waitActionable，needsEditable=false，force=false → 依然检 NOT_VISIBLE/NOT_STABLE。
      await waitActionable(tid, endFrameId, endTarget.selector, {
        timeout: args.timeout as number | undefined,
      });

      // 预加载 dom-resolve，使 page-side inline func 能穿 open shadow 解析 selector。
      await loadPageSideModule(tid, startFrameId, "dom-resolve");

      // page-side 取两元素的 getBoundingClientRect 中心坐标（视口坐标）。
      // 注：若 start/end 在不同 frame，各自独立 executeScript 取各自 frame 坐标；
      //      当前阶段假设同一 frame（v0.9 场景），跨 frame 中心留 v1.0 扩展。
      const getBbox = async (
        frameId: number | undefined,
        selector: string,
      ): Promise<{ cx: number; cy: number }> => {
        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          world: "MAIN",
          func: (sel: string) => {
            // 优先走 dom-resolve 穿 shadow，回退到 light-DOM。
            const resolve = (window as any).__vortexDomResolve;
            const el: HTMLElement | null = resolve
              ? (resolve.queryAllDeep(sel) as HTMLElement[])[0] ?? null
              : document.querySelector<HTMLElement>(sel);
            if (!el) return { ok: false as const, reason: "ELEMENT_NOT_FOUND" as const };
            // scrollIntoView 确保元素在视口内再取坐标，避免视口外 getBCR 给出屏外坐标。
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) {
              return { ok: false as const, reason: "NOT_VISIBLE" as const };
            }
            return {
              ok: true as const,
              cx: r.left + r.width / 2,
              cy: r.top + r.height / 2,
            };
          },
          args: [selector],
        });
        const res = results[0]?.result as
          | { ok: true; cx: number; cy: number }
          | { ok: false; reason: string }
          | undefined;
        if (!res?.ok) {
          const reason = (!res || !res.ok) ? (res as { ok: false; reason: string } | undefined)?.reason ?? "ELEMENT_NOT_FOUND" : "ELEMENT_NOT_FOUND";
          if (reason === "ELEMENT_NOT_FOUND") {
            throw vtxError(VtxErrorCode.ELEMENT_NOT_FOUND, `Element not found: ${selector}`);
          }
          throw vtxError(VtxErrorCode.NOT_VISIBLE, `Element not visible: ${selector}`);
        }
        return { cx: res.cx, cy: res.cy };
      };

      const from = await getBbox(startFrameId, startTarget.selector);
      // end element も預加載 dom-resolve（若 end frame 不同時）
      if (endFrameId !== startFrameId) {
        await loadPageSideModule(tid, endFrameId, "dom-resolve");
      }
      const to = await getBbox(endFrameId, endTarget.selector);

      const steps = (args.steps as number | undefined) ?? 10;

      await debuggerMgr.attach(tid);
      // CDP trusted pointer 序列:
      // 1. hover 到起点(buttons=0) → 不触发 drag
      // 2. mousePressed(buttons=1)  → 按下左键
      // 3. 分 steps 次 drag-move 到终点(buttons=1) → DnD drag-move 识别关键
      // 4. mouseReleased(buttons=0) → 松开
      await dispatchMouse(debuggerMgr, tid, "mouseMoved", from.cx, from.cy);
      await dispatchMouse(debuggerMgr, tid, "mousePressed", from.cx, from.cy, "left", 1, 1);

      const moves: Promise<void>[] = [];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const xi = from.cx + (to.cx - from.cx) * t;
        const yi = from.cy + (to.cy - from.cy) * t;
        moves.push(dispatchMouse(debuggerMgr, tid, "mouseMoved", xi, yi, "left", 1, 1));
      }
      await Promise.all(moves);

      await dispatchMouse(debuggerMgr, tid, "mouseReleased", to.cx, to.cy, "left", 1, 0);

      return {
        success: true,
        from: { x: from.cx, y: from.cy },
        to: { x: to.cx, y: to.cy },
        steps,
      };
    },

    [MouseActions.MOVE]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null && frameId !== 0) await ensureFrameAttached(tid, frameId);
      const coordSpace = resolveCoordSpace(args.coordSpace, frameId);
      const xIn = args.x as number;
      const yIn = args.y as number;
      if (xIn == null || yIn == null)
        throw vtxError(VtxErrorCode.INVALID_PARAMS, "x and y are required");

      const { x, y, offsetApplied } = await toViewportCoords(
        tid,
        xIn,
        yIn,
        frameId,
        coordSpace,
      );

      await debuggerMgr.attach(tid);
      await dispatchMouse(debuggerMgr, tid, "mouseMoved", x, y);

      return {
        success: true,
        x,
        y,
        coordSpace,
        frameId: frameId ?? null,
        offsetApplied,
      };
    },
  });
}
