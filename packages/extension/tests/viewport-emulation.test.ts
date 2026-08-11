// 视口模拟（page.setViewport）。
//
// 2026-08-11 日志分析:vortex 与 playwright 同时可用时,playwright 占 24.1% 调用,
// 其中「vortex 完全没有对应能力」的只有 32 次 —— 21 次是 browser_resize。
// 响应式验收一旦需要改视口就必须留在 playwright,用过 resize 的 6 个会话贡献了
// 全部 playwright 调用的 86.4%。这是唯一一条实证的硬能力缺口。
//
// 语义取舍:走 CDP Emulation 设备模拟（= DevTools 设备模式），**不动用户的真实窗口**。
// vortex 接管的是用户日常 Chrome，chrome.windows.update 会把用户的窗口拽走。
//
// 承重点是与截图的冲突:capture.ts 为高 DPR 截图临时下发 setDeviceMetricsOverride，
// 收尾无条件 clearDeviceMetricsOverride —— 会把常驻的视口 override 一并抹掉。
// deviceMetricsPlan 是两者唯一的合并判据，故按纯函数喂真实断言。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeViewportInput,
  deviceMetricsPlan,
  MAX_VIEWPORT_PX,
  type ViewportOverride,
} from "../src/handlers/viewport.js";
import { canUseNativeCapture } from "../src/handlers/capture.js";

const ov = (w: number, h: number, dsf = 0, mobile = false): ViewportOverride => ({
  width: w,
  height: h,
  deviceScaleFactor: dsf,
  mobile,
});

describe("normalizeViewportInput", () => {
  it("补齐默认值:deviceScaleFactor=0 表示跟随系统,不改 DPR", () => {
    expect(normalizeViewportInput({ width: 375, height: 812 })).toEqual({
      width: 375,
      height: 812,
      deviceScaleFactor: 0,
      mobile: false,
    });
  });

  it("透传 deviceScaleFactor 与 mobile", () => {
    expect(normalizeViewportInput({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true }))
      .toEqual({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  });

  it("宽高必填", () => {
    expect(() => normalizeViewportInput({ height: 812 })).toThrow(/width/i);
    expect(() => normalizeViewportInput({ width: 375 })).toThrow(/height/i);
  });

  it("拒绝非正整数:0/负数/小数", () => {
    expect(() => normalizeViewportInput({ width: 0, height: 812 })).toThrow();
    expect(() => normalizeViewportInput({ width: -1, height: 812 })).toThrow();
    expect(() => normalizeViewportInput({ width: 375.5, height: 812 })).toThrow();
  });

  it("拒绝超出上限的尺寸(防止误传把渲染器拖死)", () => {
    expect(() => normalizeViewportInput({ width: MAX_VIEWPORT_PX + 1, height: 812 })).toThrow();
    expect(normalizeViewportInput({ width: MAX_VIEWPORT_PX, height: 1 }).width).toBe(MAX_VIEWPORT_PX);
  });

  it("拒绝越界的 deviceScaleFactor", () => {
    expect(() => normalizeViewportInput({ width: 375, height: 812, deviceScaleFactor: -1 })).toThrow();
    expect(() => normalizeViewportInput({ width: 375, height: 812, deviceScaleFactor: 6 })).toThrow();
  });
});

describe("deviceMetricsPlan —— 截图 DPR 与常驻视口的合并", () => {
  it("两者都没有 → 完全不碰 Emulation", () => {
    expect(deviceMetricsPlan(undefined, undefined)).toEqual({ setup: null, teardown: null });
  });

  it("dpr=1 视同不需要覆盖(与既有 needsDprOverride 语义一致)", () => {
    expect(deviceMetricsPlan(undefined, 1)).toEqual({ setup: null, teardown: null });
  });

  it("只有截图要高 DPR → 下发后清除(既有行为不变)", () => {
    expect(deviceMetricsPlan(undefined, 2)).toEqual({
      setup: { width: 0, height: 0, deviceScaleFactor: 2, mobile: false },
      teardown: "clear",
    });
  });

  it("只有常驻视口 → 覆盖已在生效,截图不必重下发也不必收尾", () => {
    expect(deviceMetricsPlan(ov(375, 812), undefined)).toEqual({ setup: null, teardown: null });
  });

  it("常驻视口 + 高 DPR 截图 → 合并:保住视口,DPR 以截图为准", () => {
    expect(deviceMetricsPlan(ov(375, 812, 0, true), 2)).toEqual({
      setup: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true },
      teardown: { width: 375, height: 812, deviceScaleFactor: 0, mobile: true },
    });
  });

  it("收尾是恢复视口而不是 clear —— 这正是原实现会抹掉 resize 的地方", () => {
    const plan = deviceMetricsPlan(ov(1280, 900), 2);
    expect(plan.teardown).not.toBe("clear");
    expect(plan.teardown).toEqual({ width: 1280, height: 900, deviceScaleFactor: 0, mobile: false });
  });

  it("常驻视口自带 DPR 时,dpr=1 的截图不夺走它", () => {
    expect(deviceMetricsPlan(ov(375, 812, 3), 1)).toEqual({ setup: null, teardown: null });
  });
});

// captureVisibleTab 截的是**真实窗口**的可见区,与 Emulation 模拟出来的视口无关。
// 视口被模拟成 375px 时走原生快路径,会静默返回一张 1512px 宽的图 —— 尺寸对不上
// 且无任何报错,正是最难发现的一类缺陷。
describe("canUseNativeCapture —— 视口被模拟时必须回退 CDP", () => {
  const base = { fullPage: false, clip: undefined, frameId: undefined, deviceScaleFactor: undefined };

  it("默认视口截图走原生快路径(baseline 5ms vs CDP 3289ms)", () => {
    expect(canUseNativeCapture({ ...base, hasViewportOverride: false })).toBe(true);
  });

  it("有常驻视口 override → 必须走 CDP,否则截出真实窗口尺寸", () => {
    expect(canUseNativeCapture({ ...base, hasViewportOverride: true })).toBe(false);
  });

  it("既有排除条件不变:fullPage / clip / 子 frame / 高 DPR", () => {
    expect(canUseNativeCapture({ ...base, fullPage: true, hasViewportOverride: false })).toBe(false);
    expect(canUseNativeCapture({ ...base, clip: { x: 0, y: 0, width: 1, height: 1 }, hasViewportOverride: false })).toBe(false);
    expect(canUseNativeCapture({ ...base, frameId: 3, hasViewportOverride: false })).toBe(false);
    expect(canUseNativeCapture({ ...base, deviceScaleFactor: 2, hasViewportOverride: false })).toBe(false);
  });

  it("frameId=0 是主 frame,不算子 frame", () => {
    expect(canUseNativeCapture({ ...base, frameId: 0, hasViewportOverride: false })).toBe(true);
  });
});

describe("capture.ts 接入(源码锁,改一处须同步)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "capture.ts"),
    "utf8",
  );

  it("captureTab 走 deviceMetricsPlan,不再自行判断 needsDprOverride", () => {
    expect(SRC).toContain("deviceMetricsPlan(");
  });

  it("不存在无条件 clearDeviceMetricsOverride —— 必须经 plan.teardown 分支", () => {
    const clears = SRC.split("clearDeviceMetricsOverride").length - 1;
    expect(clears).toBe(1);
    const idxPlan = SRC.indexOf("deviceMetricsPlan(");
    const idxClear = SRC.indexOf("clearDeviceMetricsOverride");
    expect(idxPlan).toBeLessThan(idxClear);
  });
});
