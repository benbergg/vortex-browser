/**
 * Author: qingwa
 * Description: DebuggerManager.attach 启用 CDP focus 模拟,解后台标签渲染器节流。
 *
 * 背景 (2026-06-09 京东后台 click 5s):
 *   Chrome 对后台(hidden)标签的渲染器输入/JS 处理重度节流,CDP
 *   Input.dispatchMouseEvent 要等被节流的渲染器处理 → 后台 click ~5.2s
 *   (前台 ~500ms)。spike 实测:attach 时发
 *   Emulation.setFocusEmulationEnabled({enabled:true}) 后,后台 click 5.2s→67ms
 *   (visibilityState 翻为 visible,渲染器恢复响应)。Playwright/Puppeteer 靠启动
 *   参数,vortex 连用户现有 Chrome 只能用运行时 CDP focus 模拟。
 *
 * 关键契约:
 *   1. attach 一个新 tab → 发 Emulation.setFocusEmulationEnabled({enabled:true})
 *   2. focus 模拟失败(老 Chrome 不支持) → 不影响 attach 成功(best-effort)
 *   3. 同一 tab 重复 attach → 不重发(attachedTabs 去重)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

function mkChrome() {
  return {
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  };
}

describe("DebuggerManager.attach focus 模拟 (京东后台 click 5s 修复)", () => {
  beforeEach(() => vi.resetModules());

  it("契约 1: attach 新 tab → 发 Emulation.setFocusEmulationEnabled({enabled:true})", async () => {
    const chrome = mkChrome();
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    const mgr = new DebuggerManager();

    await mgr.attach(42);

    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, "1.3");
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 },
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
    );
  });

  it("契约 2: focus 模拟失败 → attach 仍成功(best-effort)", async () => {
    const chrome = mkChrome();
    chrome.debugger.sendCommand.mockRejectedValue(new Error("not supported"));
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    const mgr = new DebuggerManager();

    await expect(mgr.attach(42)).resolves.toBeUndefined();
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("契约 3: 同一 tab 重复 attach → 不重发 focus 模拟", async () => {
    const chrome = mkChrome();
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    const mgr = new DebuggerManager();

    await mgr.attach(42);
    await mgr.attach(42);

    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });
});
