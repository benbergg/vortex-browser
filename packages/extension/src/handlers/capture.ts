// packages/extension/src/handlers/capture.ts

import { CaptureActions, VtxErrorCode, vtxError } from "@bytenew/vortex-shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { getIframeOffset } from "../lib/iframe-offset.js";
import { resolveTarget } from "../lib/resolve-target.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";

// GIF 录制状态
interface GifSession {
  tabId: number;
  frames: string[]; // data URL 数组
  interval: ReturnType<typeof setInterval>;
  startTime: number;
}

let activeGifSession: GifSession | null = null;

// fullPage 截图的高度上限（CDP 单帧能力上限，超过则裁到此高度）
const MAX_FULLPAGE_HEIGHT = 8000;

interface CaptureResult {
  dataUrl: string;
  /** fullPage 内容超过 MAX_FULLPAGE_HEIGHT 被裁断时填充，告知调用方下半部分丢失 */
  truncation?: { contentHeight: number; capturedHeight: number };
}

/**
 * 基于 CDP Page.captureScreenshot 的截图实现。
 * 不要求 tab 活跃，支持 viewport / fullPage / clip 三种模式。
 * 内部字段：deviceScaleFactor 用于 bench LLM-judge 高 DPR 截图，frameId 为单 frame clip。
 */
async function captureTab(
  debuggerMgr: DebuggerManager,
  tabId: number,
  options: {
    format?: "png" | "jpeg";
    quality?: number;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    deviceScaleFactor?: 1 | 2;
  } = {},
): Promise<CaptureResult> {
  const { format = "png", quality, fullPage = false, clip, deviceScaleFactor } = options;

  await debuggerMgr.enableDomain(tabId, "Page");

  const needsDprOverride = deviceScaleFactor != null && deviceScaleFactor !== 1;
  if (needsDprOverride) {
    await debuggerMgr.enableDomain(tabId, "Emulation");
    await debuggerMgr.sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor,
      width: 0,
      height: 0,
      mobile: false,
    });
  }

  let truncation: CaptureResult["truncation"];
  try {
    const params: any = {
      format,
      captureBeyondViewport: fullPage || !!clip,
    };
    if (format === "jpeg" && quality != null) params.quality = quality;
    if (clip) {
      params.clip = { ...clip, scale: 1 };
    } else if (fullPage) {
      const metrics = await debuggerMgr.sendCommand(tabId, "Page.getLayoutMetrics") as any;
      const contentSize = metrics.cssContentSize ?? metrics.contentSize;
      const capturedHeight = Math.min(contentSize.height, MAX_FULLPAGE_HEIGHT);
      if (contentSize.height > MAX_FULLPAGE_HEIGHT) {
        truncation = { contentHeight: contentSize.height, capturedHeight };
      }
      params.clip = {
        x: 0,
        y: 0,
        width: contentSize.width,
        height: capturedHeight,
        scale: 1,
      };
    }
    const result = await debuggerMgr.sendCommand(tabId, "Page.captureScreenshot", params) as { data: string };
    return { dataUrl: `data:image/${format};base64,${result.data}`, truncation };
  } finally {
    if (needsDprOverride) {
      // 设计文档 §3.5 + 决策 6: reset 失败让异常向上抛,bench sweep 应 abort
      await debuggerMgr.sendCommand(tabId, "Emulation.clearDeviceMetricsOverride", {});
    }
  }
}

/**
 * 单截某 frame 时计算 viewport bbox 作 CDP clip。
 * 用 chrome.scripting.executeScript 在目标 frame 内取 documentElement bounding rect,
 * 再加 iframe-offset 拼绝对坐标。frameId=0 不走此路径(由 SCREENSHOT handler 守卫)。
 */
async function computeFrameClip(
  tabId: number,
  frameId: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await ensureFrameAttached(tabId, frameId);
  const rectResults = await chrome.scripting.executeScript({
    target: buildExecuteTarget(tabId, frameId),
    func: () => {
      const r = document.documentElement.getBoundingClientRect();
      return { result: { x: r.left, y: r.top, width: r.width, height: r.height } };
    },
    world: "MAIN",
  });
  const rect = (rectResults[0]?.result as { result?: any })?.result;
  if (!rect) {
    throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `Failed to compute clip for frameId=${frameId}`);
  }
  const { x: offsetX, y: offsetY } = await getIframeOffset(tabId, frameId);
  return {
    x: rect.x + offsetX,
    y: rect.y + offsetY,
    width: rect.width,
    height: rect.height,
  };
}

export function registerCaptureHandlers(
  router: ActionRouter,
  debuggerMgr: DebuggerManager,
): void {
  router.registerAll({
    [CaptureActions.SCREENSHOT]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const format = (args.format as "png" | "jpeg") ?? "png";
      const quality = args.quality as number | undefined;
      const fullPage = args.fullPage as boolean | undefined;
      const clip = args.clip as { x: number; y: number; width: number; height: number } | undefined;
      const deviceScaleFactor = args.deviceScaleFactor as 1 | 2 | undefined;
      const frameId = args.frameId as number | undefined;

      let effectiveClip = clip;
      if (frameId != null && frameId !== 0 && !clip) {
        effectiveClip = await computeFrameClip(tid, frameId);
      }

      const { dataUrl, truncation } = await captureTab(debuggerMgr, tid, { format, quality, fullPage, clip: effectiveClip, deviceScaleFactor });

      return {
        dataUrl,
        format,
        ...(format === "jpeg" && quality != null ? { quality } : {}),
        ...(deviceScaleFactor != null ? { deviceScaleFactor } : {}),
        ...(frameId != null ? { frameId } : {}),
        fullPage: !!fullPage,
        ...(truncation
          ? { truncated: true, contentHeight: truncation.contentHeight, capturedHeight: truncation.capturedHeight }
          : {}),
        timestamp: Date.now(),
      };
    },

    [CaptureActions.ELEMENT]: async (args, tabId) => {
      // 复用 resolveTarget:支持 selector 或 @ref(index+snapshotId),与 DOM 类 handler 一致
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const format = (args.format as "png" | "jpeg") ?? "png";
      const quality = args.quality as number | undefined;

      // 加载 dom-resolve,使 inline func 经 queryDeep 穿 open shadow 解析 selector——
      // 否则 document.querySelector 不穿 shadow,shadow 内元素的 @ref 截图 ELEMENT_NOT_FOUND
      // (族 K 读路径 shadow 穿透,与 content.ts/dom.ts 一致)。
      await loadPageSideModule(tid, frameId, "dom-resolve");

      // 1. 在目标 frame 内取元素 rect
      const rectResults = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: (sel: string) => {
          const el = (window as any).__vortexDomResolve.queryDeep(sel);
          if (!el) return { error: `Element not found: ${sel}` };
          const r = el.getBoundingClientRect();
          return {
            result: { x: r.left, y: r.top, width: r.width, height: r.height },
          };
        },
        args: [selector],
        world: "MAIN",
      });
      const rectRes = rectResults[0]?.result as { result?: any; error?: string };
      if (rectRes?.error) throw vtxError(rectRes.error.startsWith("Element not found:") ? VtxErrorCode.ELEMENT_NOT_FOUND : VtxErrorCode.JS_EXECUTION_ERROR, rectRes.error, { selector });
      const rect = rectRes.result;

      // 零尺寸元素（display:none / 隐藏 / 0×0 box）无法截图:优雅报 NOT_VISIBLE,
      // 而非把下游 CDP 的 "Cannot take screenshot with 0 width" 裸错粗归为 JS_EXECUTION_ERROR。
      if (rect.width === 0 || rect.height === 0) {
        throw vtxError(
          VtxErrorCode.NOT_VISIBLE,
          `Element ${selector} has zero dimensions (hidden / display:none / 0×0 box), cannot screenshot`,
          { selector },
        );
      }

      // 2. iframe 坐标偏移（复用共享工具）
      const { x: offsetX, y: offsetY } = await getIframeOffset(tid, frameId);

      // 3. CDP 裁剪截图
      const { dataUrl } = await captureTab(debuggerMgr, tid, {
        format,
        quality,
        clip: {
          x: rect.x + offsetX,
          y: rect.y + offsetY,
          width: rect.width,
          height: rect.height,
        },
      });

      return {
        dataUrl,
        format,
        ...(format === "jpeg" && quality != null ? { quality } : {}),
        selector,
        rect: {
          x: rect.x + offsetX,
          y: rect.y + offsetY,
          width: rect.width,
          height: rect.height,
        },
        timestamp: Date.now(),
      };
    },

    [CaptureActions.GIF_START]: async (args, tabId) => {
      if (activeGifSession) throw vtxError(VtxErrorCode.INVALID_PARAMS, "GIF recording already in progress", { extras: { state: "already_recording" } }, { hint: "Stop the current recording with vortex_capture_gif_stop before starting a new one." });

      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const fps = (args.fps as number) ?? 2;
      const intervalMs = Math.round(1000 / fps);

      activeGifSession = {
        tabId: tid,
        frames: [],
        startTime: Date.now(),
        interval: setInterval(async () => {
          if (!activeGifSession) return;
          try {
            const { dataUrl } = await captureTab(debuggerMgr, activeGifSession.tabId, { format: "png" });
            activeGifSession.frames.push(dataUrl);
          } catch (err) {
            console.error("[capture] gif frame error:", err);
          }
        }, intervalMs),
      };

      return { recording: true, tabId: tid, fps };
    },

    [CaptureActions.GIF_FRAME]: async () => {
      if (!activeGifSession) throw vtxError(VtxErrorCode.INVALID_PARAMS, "No GIF recording in progress", { extras: { state: "not_recording" } }, { hint: "Call vortex_capture_gif_start first." });

      const { dataUrl } = await captureTab(debuggerMgr, activeGifSession.tabId, { format: "png" });
      activeGifSession.frames.push(dataUrl);

      return { frameCount: activeGifSession.frames.length };
    },

    [CaptureActions.GIF_STOP]: async () => {
      if (!activeGifSession) throw vtxError(VtxErrorCode.INVALID_PARAMS, "No GIF recording in progress", { extras: { state: "not_recording" } }, { hint: "Call vortex_capture_gif_start first." });

      clearInterval(activeGifSession.interval);
      const session = activeGifSession;
      activeGifSession = null;

      return {
        frames: session.frames,
        frameCount: session.frames.length,
        duration: Date.now() - session.startTime,
        tabId: session.tabId,
      };
    },
  });
}
