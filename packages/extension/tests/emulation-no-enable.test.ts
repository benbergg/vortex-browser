/**
 * Author: qingwa
 * Description: Emulation 域没有 enable 命令,只能 attach 后直接发。
 *
 * 2026-08-11 live 实证:调 `Emulation.enable` 真机报
 *   {"code":-32601,"message":"'Emulation.enable' wasn't found"}
 * 这是 main 上的既有缺陷 —— capture.ts 为高 DPR 截图走
 * `enableDomain(tabId, "Emulation")`,于是 deviceScaleFactor=2 的截图一直失败,
 * 单测里 DebuggerManager 全是 mock、任何 `${domain}.enable` 都被 resolve 掉,
 * 所以一路假绿。DebuggerManager.attach 自己就成功发着
 * Emulation.setFocusEmulationEnabled —— 反证 Emulation 命令不需要 enable。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function mkChrome() {
  return {
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      // 真机行为:未知命令直接 reject,而不是 resolve
      sendCommand: vi.fn().mockImplementation((_t: unknown, method: string) => {
        if (method === "Emulation.enable") {
          return Promise.reject(new Error("{\"code\":-32601,\"message\":\"'Emulation.enable' wasn't found\"}"));
        }
        return Promise.resolve(undefined);
      }),
      detach: vi.fn().mockResolvedValue(undefined),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  };
}

describe("Emulation 域不可 enable", () => {
  beforeEach(() => vi.resetModules());

  it("enableDomain('Emulation') 在真机行为下必然抛 —— 记录为什么不能用它", async () => {
    const chrome = mkChrome();
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    await expect(new DebuggerManager().enableDomain(7, "Emulation")).rejects.toThrow(/wasn't found/);
  });

  it("attach 不发任何 .enable,可安全承载 Emulation 命令", async () => {
    const chrome = mkChrome();
    vi.stubGlobal("chrome", chrome);
    const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
    const mgr = new DebuggerManager();

    await mgr.attach(7);
    await mgr.sendCommand(7, "Emulation.setDeviceMetricsOverride", { width: 375, height: 812 });

    const methods = chrome.debugger.sendCommand.mock.calls.map((c: unknown[]) => c[1]);
    expect(methods.some((m) => String(m).endsWith(".enable"))).toBe(false);
    expect(methods).toContain("Emulation.setDeviceMetricsOverride");
  });
});

describe("调用方接线(源码锁)", () => {
  const read = (...p: string[]) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", ...p), "utf8");

  it("capture.ts 不再 enableDomain('Emulation')", () => {
    expect(read("handlers", "capture.ts")).not.toContain('enableDomain(tabId, "Emulation")');
  });

  it("viewport.ts 不 enableDomain('Emulation')", () => {
    expect(read("handlers", "viewport.ts")).not.toMatch(/enableDomain\([^)]*"Emulation"/);
  });

  it("两处都走 attach 承载 Emulation 命令", () => {
    expect(read("handlers", "capture.ts")).toMatch(/debuggerMgr\.attach\(/);
    expect(read("handlers", "viewport.ts")).toMatch(/debuggerMgr\.attach\(/);
  });
});
