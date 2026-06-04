import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 白盒审计批次 4 族 N — NAV-1。
 *
 * navigate waitUntil="domcontentloaded" 原与 load 同走 waitForTabLoad(只认 tab
 * 'complete' = 所有子资源),DOM 秒就绪的慢站(挂起 img/长尾资源)仍阻塞 ~25s +
 * degraded(line 85 注释还文档化了不存在的"DCL 即返回")。修复:DCL 用
 * chrome.webNavigation.onDOMContentLoaded(主 frame)精确捕获新文档 DOM 解析完成,
 * 不等子资源即早返回。
 */

let dclListeners: Array<(d: { tabId: number; frameId: number }) => void>;
let executeScriptMock: Mock;

function installChrome(readyState: string) {
  dclListeners = [];
  executeScriptMock = vi.fn().mockResolvedValue([{ result: readyState }]);
  (globalThis as any).chrome = {
    scripting: { executeScript: executeScriptMock },
    webNavigation: {
      onDOMContentLoaded: {
        addListener: vi.fn((cb: (d: { tabId: number; frameId: number }) => void) => {
          dclListeners.push(cb);
        }),
        removeListener: vi.fn((cb: any) => {
          dclListeners = dclListeners.filter((l) => l !== cb);
        }),
      },
    },
  };
}

function fireDcl(tabId: number, frameId: number) {
  for (const l of [...dclListeners]) l({ tabId, frameId });
}

async function importPage() {
  vi.resetModules();
  return import("../src/handlers/page.js");
}

describe("waitForDomReady — DCL 早返回 (NAV-1)", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("主 frame onDOMContentLoaded 触发 → resolve { degraded: false }(不等 timeout)", async () => {
    installChrome("interactive");
    const { waitForDomReady } = await importPage();
    const p = waitForDomReady(100, 25_000);
    fireDcl(100, 0);
    await expect(p).resolves.toEqual({ degraded: false });
  });

  it("子 frame(frameId≠0)的 DCL 不算数,只认主 frame", async () => {
    vi.useFakeTimers();
    installChrome("complete");
    const { waitForDomReady } = await importPage();
    const settled = waitForDomReady(100, 25_000).then((v) => ({ ok: true, v }));
    fireDcl(100, 7); // 子 frame，应被忽略
    // 仍未 resolve；推进到 timeout 才按 readyState 降级
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await settled).toEqual({ ok: true, v: { degraded: true } });
  });

  it("别的 tab 的 DCL 不算数", async () => {
    installChrome("interactive");
    const { waitForDomReady } = await importPage();
    const p = waitForDomReady(100, 25_000);
    fireDcl(999, 0); // 别的 tab
    fireDcl(100, 0); // 目标 tab 主 frame
    await expect(p).resolves.toEqual({ degraded: false });
  });

  it("超时但 readyState=complete → 优雅降级 { degraded: true }(不 throw)", async () => {
    vi.useFakeTimers();
    installChrome("complete");
    const { waitForDomReady } = await importPage();
    const settled = waitForDomReady(100, 25_000).then(
      (v) => ({ ok: true, v }),
      (e: Error) => ({ ok: false, msg: e.message }),
    );
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await settled).toEqual({ ok: true, v: { degraded: true } });
  });

  it("超时且 readyState=loading → reject TIMEOUT", async () => {
    vi.useFakeTimers();
    installChrome("loading");
    const { waitForDomReady } = await importPage();
    const settled = waitForDomReady(100, 25_000).then(
      (v) => ({ ok: true, v }),
      (e: Error) => ({ ok: false, msg: e.message }),
    );
    await vi.advanceTimersByTimeAsync(25_000);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect((outcome as { msg: string }).msg.toLowerCase()).toContain("timeout");
  });
});

describe("navigate domcontentloaded 接线 (NAV-1)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "page.ts"),
    "utf8",
  );

  it("domcontentloaded 分支走 waitForDomReady 而非 waitForTabLoad", () => {
    expect(SRC).toMatch(/waitUntil === "domcontentloaded"/);
    expect(SRC).toMatch(/waitForDomReady\(/);
  });

  it("DCL 监听器在 tabs.update 之前挂上(消除快页面竞态)", () => {
    // waitForDomReady(...) 的调用须出现在 chrome.tabs.update 之前。
    const idxWait = SRC.indexOf("waitForDomReady(tid");
    const idxUpdate = SRC.indexOf("chrome.tabs.update(tid, { url })");
    expect(idxWait).toBeGreaterThan(-1);
    expect(idxUpdate).toBeGreaterThan(-1);
    expect(idxWait).toBeLessThan(idxUpdate);
  });
});
