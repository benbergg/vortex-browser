import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:navigate 在 `load` 超时但页面其实已可用时优雅降级(2026-06-03 第十六轮
 * DuckDuckGo 真实站 dogfood)。
 *
 * 现象:`vortex_navigate(url, waitUntil:"load")` 对 DDG 硬 throw TIMEOUT(默认 30s),
 *   但 `document.readyState === "complete"`、URL/title 都对、页面完全可交互。根因:
 *   `waitForTabLoad` 监听 `chrome.tabs.onUpdated` 的 `status === "complete"`——这是
 *   **tab 级**加载态,反映**所有**网络活动(图片/广告/tracker/持久连接),与
 *   `document.readyState`(load 事件)是两个信号。真实站 `load` 等所有子资源,常态
 *   >30s 甚至永不触发。而 `load` 路径超时直接 reject,把 agent 困死,即使页面可用;
 *   形成与 `networkidle` 路径(已优雅降级)的语义不一致。
 *
 * 修复:`load`/默认路径超时时探一次 `document.readyState`——若已 `interactive`/
 *   `complete`(DOM 已解析可用),解析为 `{ degraded: true }` 让 navigate 成功返回
 *   (附 degraded 标记),agent 可继续 observe/act;仅当 DOM 仍 `loading`(真未就绪)
 *   才 reject TIMEOUT。
 */

let executeScriptMock: Mock;
let onUpdatedFire: (tabId: number, changeInfo: { status?: string }) => void;

function installChrome(readyState: string) {
  let updatedCb: ((tabId: number, changeInfo: { status?: string }) => void) | undefined;
  executeScriptMock = vi.fn().mockResolvedValue([{ result: readyState }]);
  (globalThis as any).chrome = {
    scripting: { executeScript: executeScriptMock },
    tabs: {
      onUpdated: {
        addListener: vi.fn((cb: typeof updatedCb) => {
          updatedCb = cb;
        }),
        removeListener: vi.fn(),
      },
    },
  };
  onUpdatedFire = (tabId, changeInfo) => updatedCb?.(tabId, changeInfo);
}

async function importPage() {
  vi.resetModules();
  return import("../src/handlers/page.js");
}

describe("navigate waitForTabLoad 超时优雅降级 (DDG dogfood 2026-06-03)", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("快路径:onUpdated 触发 complete → resolve { degraded: false }", async () => {
    installChrome("complete");
    const { waitForTabLoad } = await importPage();
    const p = waitForTabLoad(100, 30_000);
    onUpdatedFire(100, { status: "complete" });
    await expect(p).resolves.toEqual({ degraded: false });
    // 快路径不应探 readyState。
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  it("超时但 readyState=complete → 优雅降级 resolve { degraded: true }(不 throw)", async () => {
    vi.useFakeTimers();
    installChrome("complete");
    const { waitForTabLoad } = await importPage();
    const settled = waitForTabLoad(100, 30_000).then(
      (v) => ({ ok: true, v }),
      (e: Error) => ({ ok: false, msg: e.message }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await settled;
    expect(outcome).toEqual({ ok: true, v: { degraded: true } });
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
  });

  it("超时但 readyState=interactive → 同样优雅降级(DOM 已解析即可用)", async () => {
    vi.useFakeTimers();
    installChrome("interactive");
    const { waitForTabLoad } = await importPage();
    const settled = waitForTabLoad(100, 30_000).then(
      (v) => ({ ok: true, v }),
      (e: Error) => ({ ok: false, msg: e.message }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settled).toEqual({ ok: true, v: { degraded: true } });
  });

  it("超时且 readyState=loading → 真未就绪,reject TIMEOUT", async () => {
    vi.useFakeTimers();
    installChrome("loading");
    const { waitForTabLoad } = await importPage();
    const settled = waitForTabLoad(100, 30_000).then(
      (v) => ({ ok: true, v }),
      (e: Error) => ({ ok: false, msg: e.message }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect((outcome as { msg: string }).msg.toLowerCase()).toContain("timeout");
  });
});

describe("navigate 内部 load 等待 < MCP 传输超时 margin (DDG dogfood 2026-06-03)", () => {
  // 根因第二层:handler 优雅降级与 MCP 传输层（client.ts，默认 30s）竞速。两者都用满
  // 30s 时传输层以微弱差距先放弃,降级响应到不了 caller。故 navigate 内部 load 等待必须
  // 严格小于传输超时,留出 readyState 探测 + WS 回程的 margin。
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "page.ts"),
    "utf8",
  );

  it("定义 NAVIGATE_LOAD_TIMEOUT_MS 且严格 < 30000（传输层默认）", () => {
    const m = SRC.match(/NAVIGATE_LOAD_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(m).not.toBeNull();
    const val = parseInt(m![1].replace(/_/g, ""), 10);
    expect(val).toBeLessThan(30_000);
    // 至少留 3s margin 覆盖探测 + 回程。
    expect(val).toBeLessThanOrEqual(27_000);
  });

  it("navigate load 等待用 Math.min(outerTimeout, NAVIGATE_LOAD_TIMEOUT_MS) cap,不裸用 outerTimeout", () => {
    expect(SRC).toMatch(/Math\.min\(\s*outerTimeout\s*,\s*NAVIGATE_LOAD_TIMEOUT_MS\s*\)/);
  });

  // reload/back/forward 同病:裸 waitForTabLoad(tid) 用默认 30s == 传输超时 → 慢站
  // 降级响应到不了 caller。须同 navigate cap 在 NAVIGATE_LOAD_TIMEOUT_MS(2026-06-04 审计)。
  it("reload/back/forward 不再裸用 waitForTabLoad(tid)(默认 30s == 传输)", () => {
    // 不应出现裸调用(无第二个 timeout 实参)。
    expect(SRC).not.toMatch(/waitForTabLoad\(tid\)\s*;/);
  });

  it("reload/back/forward 的 load 等待 cap 在 NAVIGATE_LOAD_TIMEOUT_MS", () => {
    const calls = SRC.match(/waitForTabLoad\(tid,\s*NAVIGATE_LOAD_TIMEOUT_MS\)/g) ?? [];
    // reload + back + forward 三处。
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("network_idle 默认 timeout 用 NAVIGATE_LOAD_TIMEOUT_MS 而非裸 30000(== 传输)", () => {
    // WAIT_FOR_NETWORK_IDLE 超时是 reject(非优雅降级),默认 30s == 传输会让
    // TIMEOUT 错误被传输层 "no response" 抢先,改用 < 传输的 margin。
    // network_idle 默认行:timeout: (args.timeout as number) ?? NAVIGATE_LOAD_TIMEOUT_MS
    // (XHR idle 用 ?? 10_000、navigate 用 Math.min,故此式唯一指向 network_idle)。
    expect(SRC).toMatch(
      /timeout:\s*\(args\.timeout as number\)\s*\?\?\s*NAVIGATE_LOAD_TIMEOUT_MS/,
    );
    expect(SRC).not.toMatch(/timeout:\s*\(args\.timeout as number\)\s*\?\?\s*30_000/);
  });
});
