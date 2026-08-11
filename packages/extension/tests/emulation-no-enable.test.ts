/**
 * Author: qingwa
 * Description: Emulation 命令只需 attach，不能走 enableDomain。
 *
 * 2026-08-11 live 实证:调 `Emulation.enable` 真机报
 *   {"code":-32601,"message":"'Emulation.enable' wasn't found"}
 * 这是 main 上的既有缺陷 —— capture.ts 为高 DPR 截图走
 * `enableDomain(tabId, "Emulation")`,于是 deviceScaleFactor=2 的截图一直失败,
 * 而单测里的假 DebuggerManager 把任意 `${domain}.enable` 一律 resolve,所以一路假绿。
 *
 * 现在有三道防线,本文件只管第三道:
 *   1. 生产守卫 assertEnableable —— 见 cdp-enable-guard.test.ts
 *   2. 源码不变量 I23 —— 取代了本文件原先针对 Emulation 的字符串源码锁
 *   3. Emulation 命令在 attach 之后确实可用（下面）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeChromeDebugger } from "./helpers/fake-debugger.js";

describe("Emulation 命令承载在 attach 上", () => {
  beforeEach(() => vi.resetModules());

  it("attach 不发任何 .enable，随后 Emulation 命令照常送达", async () => {
    const chrome = createFakeChromeDebugger();
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    const mgr = new DebuggerManager();

    await mgr.attach(7);
    await mgr.sendCommand(7, "Emulation.setDeviceMetricsOverride", { width: 375, height: 812 });

    const methods = chrome.debugger.sendCommand.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(methods.some((m) => m.endsWith(".enable"))).toBe(false);
    expect(methods).toContain("Emulation.setDeviceMetricsOverride");
  });

  it("attach 自己发的 setFocusEmulationEnabled 也是 Emulation 域，反证不需要 enable", async () => {
    const chrome = createFakeChromeDebugger();
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");

    await new DebuggerManager().attach(7);

    const methods = chrome.debugger.sendCommand.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(methods).toContain("Emulation.setFocusEmulationEnabled");
  });
});
