/**
 * Author: qingwa
 * Description: enableDomain 对没有 enable 命令的域必须当场拒绝，而不是发出去等真机报错。
 *
 * 背景:`Emulation.enable` 并不存在,真机报 -32601 'Emulation.enable' wasn't found。
 * capture.ts 曾用 enableDomain(tabId,"Emulation") 让高 DPR 截图坏了很久,而单测里的
 * 假 DebuggerManager 把任意 `${domain}.enable` 一律 resolve —— 危险路径在测试里变安全,
 * 于是一路假绿。守卫放在生产侧,任何调用方都躲不过。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeChromeDebugger } from "./helpers/fake-debugger.js";

async function mgr() {
  const chrome = createFakeChromeDebugger();
  vi.stubGlobal("chrome", chrome);
  const { DebuggerManager } = await import("../src/lib/debugger-manager.js");
  return { mgr: new DebuggerManager(), chrome };
}

describe("enableDomain 的域守卫", () => {
  beforeEach(() => vi.resetModules());

  it("对没有 enable 命令的域直接抛，不把注定失败的命令发出去", async () => {
    const { mgr: m, chrome } = await mgr();
    await expect(m.enableDomain(7, "Emulation")).rejects.toThrow(/enable/i);
    const methods = chrome.debugger.sendCommand.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(methods).not.toContain("Emulation.enable");
  });

  it("报错要说清怎么办：要么改走 attach，要么确认协议后加进白名单", async () => {
    const { mgr: m } = await mgr();
    await expect(m.enableDomain(7, "Emulation")).rejects.toThrow(/attach|DOMAINS_WITH_ENABLE/);
  });

  it("合法域照常 enable", async () => {
    const { mgr: m, chrome } = await mgr();
    await m.enableDomain(7, "DOM");
    const methods = chrome.debugger.sendCommand.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(methods).toContain("DOM.enable");
  });

  it("没见过的域一律拒绝，逼调用方去查协议而不是撞运气", async () => {
    const { mgr: m } = await mgr();
    await expect(m.enableDomain(7, "Wombat")).rejects.toThrow();
  });
});

describe("共享假 chrome.debugger 复刻真机行为", () => {
  beforeEach(() => vi.resetModules());

  it("未知命令 reject 并带 -32601，而不是静默 resolve", async () => {
    const chrome = createFakeChromeDebugger();
    await expect(
      chrome.debugger.sendCommand({ tabId: 1 }, "Emulation.enable", {}),
    ).rejects.toThrow(/-32601|wasn't found/);
  });

  it("代码库真正在用的命令放行", async () => {
    const chrome = createFakeChromeDebugger();
    await expect(
      chrome.debugger.sendCommand({ tabId: 1 }, "Emulation.setDeviceMetricsOverride", {}),
    ).resolves.toBeDefined();
  });

  it("允许按需给单条命令指定返回值", async () => {
    const chrome = createFakeChromeDebugger({
      responses: { "Page.getLayoutMetrics": { cssContentSize: { width: 3, height: 4 } } },
    });
    await expect(
      chrome.debugger.sendCommand({ tabId: 1 }, "Page.getLayoutMetrics", {}),
    ).resolves.toMatchObject({ cssContentSize: { width: 3, height: 4 } });
  });

  it("允许显式放行额外命令，供测试构造尚未使用的路径", async () => {
    const chrome = createFakeChromeDebugger({ allow: ["Wombat.dance"] });
    await expect(chrome.debugger.sendCommand({ tabId: 1 }, "Wombat.dance", {})).resolves.toBeDefined();
  });
});
