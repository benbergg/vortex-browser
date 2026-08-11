// packages/extension/src/handlers/viewport.ts

import { PageActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId } from "../lib/tab-utils.js";

/** CDP 渲染器对超大 surface 会退化甚至崩渲染进程,给个务实上限 */
export const MAX_VIEWPORT_PX = 10000;
const MAX_DEVICE_SCALE_FACTOR = 5;

export interface ViewportOverride {
  width: number;
  height: number;
  /** 0 = 跟随系统,不改 DPR */
  deviceScaleFactor: number;
  mobile: boolean;
}

export interface DeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export interface DeviceMetricsPlan {
  /** 需要下发的 setDeviceMetricsOverride 参数;null = 无需下发 */
  setup: DeviceMetrics | null;
  /** 收尾动作:恢复成该参数 / "clear" 清除 / null 不收尾 */
  teardown: DeviceMetrics | "clear" | null;
}

const overrides = new Map<number, ViewportOverride>();

export function getViewportOverride(tabId: number): ViewportOverride | undefined {
  return overrides.get(tabId);
}

export function setViewportOverride(tabId: number, ov: ViewportOverride): void {
  overrides.set(tabId, ov);
}

export function clearViewportOverride(tabId: number): void {
  overrides.delete(tabId);
}

export function normalizeViewportInput(args: Record<string, unknown>): ViewportOverride {
  const width = requirePositiveInt(args.width, "width", MAX_VIEWPORT_PX);
  const height = requirePositiveInt(args.height, "height", MAX_VIEWPORT_PX);
  const dsf = args.deviceScaleFactor;
  let deviceScaleFactor = 0;
  if (dsf != null) {
    if (typeof dsf !== "number" || !Number.isFinite(dsf) || dsf < 0 || dsf > MAX_DEVICE_SCALE_FACTOR) {
      throw vtxError(
        VtxErrorCode.INVALID_PARAMS,
        `deviceScaleFactor must be a number in [0, ${MAX_DEVICE_SCALE_FACTOR}] (0 = follow system)`,
      );
    }
    deviceScaleFactor = dsf;
  }
  return { width, height, deviceScaleFactor, mobile: args.mobile === true };
}

function requirePositiveInt(v: unknown, name: string, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) {
    throw vtxError(
      VtxErrorCode.INVALID_PARAMS,
      `${name} must be an integer in [1, ${max}] CSS px`,
    );
  }
  return v;
}

/**
 * 常驻视口 override 与截图临时高 DPR 的唯一合并判据。
 *
 * 截图收尾原本无条件 clearDeviceMetricsOverride,会把 vortex_resize 设的视口一并抹掉;
 * 故有常驻视口时收尾必须「恢复」而非「清除」。dpr=1 视同不需要覆盖,保持既有语义。
 */
export function deviceMetricsPlan(
  stored: ViewportOverride | undefined,
  screenshotDpr?: number,
): DeviceMetricsPlan {
  const wantsDpr = screenshotDpr != null && screenshotDpr !== 1;
  if (!wantsDpr) return { setup: null, teardown: null };
  if (!stored) {
    return {
      setup: { width: 0, height: 0, deviceScaleFactor: screenshotDpr, mobile: false },
      teardown: "clear",
    };
  }
  return {
    setup: { ...stored, deviceScaleFactor: screenshotDpr },
    teardown: { ...stored },
  };
}

export function registerViewportHandlers(router: ActionRouter, debuggerMgr: DebuggerManager): void {
  router.registerAll({
    [PageActions.SET_VIEWPORT]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      // Emulation 域没有 enable 命令(真机 -32601),attach 后直接发即可
      await debuggerMgr.attach(tid);

      if (args.reset === true) {
        await debuggerMgr.sendCommand(tid, "Emulation.clearDeviceMetricsOverride", {});
        clearViewportOverride(tid);
        return { tabId: tid, reset: true };
      }

      const ov = normalizeViewportInput(args);
      await debuggerMgr.sendCommand(tid, "Emulation.setDeviceMetricsOverride", ov);
      setViewportOverride(tid, ov);
      return { tabId: tid, ...ov };
    },
  });
}
