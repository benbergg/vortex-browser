import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VtxErrorCode } from "@vortex-browser/shared";

/**
 * Bug 修复:vortex_history (page.back / page.forward) 在「vortex_navigate
 * (chrome.tabs.update 发起、无页面内用户手势)建立的历史」上失败。
 *
 * 根因(2026-06-06 白盒+e2e 确诊):chrome.tabs.goBack/goForward 受 Chrome
 * history-manipulation intervention 影响,跳过扩展导航 entry,报原生错误
 * "Cannot find a next page in history" —— 即便 window.history.length 正确、
 * 页面级 history.back() 能后退。实证:同一 tab 同一历史栈同一位置,页面级
 * back 成功、扩展级 chrome.tabs.goBack 失败。
 *
 * 修复:改用 CDP Page.getNavigationHistory(拿 currentIndex + entries)+
 * Page.navigateToHistoryEntry(按 entryId 精确导航),绕过 UI-skip。边界
 * (已在栈底/顶)抛 NO_EFFECT 而非裸 Error 被 router 兜底成 JS_EXECUTION_ERROR。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "page.ts"),
  "utf8",
);

type NavHistory = {
  currentIndex: number;
  entries: Array<{ id: number; url: string }>;
};

function mkDebuggerMgr(history: NavHistory, opts?: { attachError?: Error; historyError?: Error; navigateError?: Error }) {
  return {
    attach: vi.fn().mockImplementation(() =>
      opts?.attachError ? Promise.reject(opts.attachError) : Promise.resolve(undefined),
    ),
    sendCommand: vi.fn().mockImplementation((_tid: number, method: string) => {
      if (method === "Page.getNavigationHistory") {
        return opts?.historyError ? Promise.reject(opts.historyError) : Promise.resolve(history);
      }
      if (method === "Page.navigateToHistoryEntry" && opts?.navigateError) {
        return Promise.reject(opts.navigateError);
      }
      return Promise.resolve(undefined);
    }),
  };
}

/** Chrome 拒绝恢复历史项时的真实 CDP 错误形态（message 是 JSON 文本）。 */
function refusalError(message = "Not allowed", code = -32000): Error {
  return new Error(JSON.stringify({ code, message }));
}

async function importPage() {
  vi.resetModules();
  return import("../src/handlers/page.js");
}

describe("navigateHistory — CDP 按 index 后退/前进(绕过 chrome.tabs.goBack skip)", () => {
  it("back(delta=-1): 精确导航到 currentIndex-1 的 entryId", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr({
      currentIndex: 2,
      entries: [
        { id: 10, url: "a" },
        { id: 20, url: "b" },
        { id: 30, url: "c" },
      ],
    });
    await navigateHistory(dbg as never, 42, -1);
    expect(dbg.sendCommand).toHaveBeenCalledWith(42, "Page.navigateToHistoryEntry", {
      entryId: 20,
    });
  });

  it("forward(delta=+1): 精确导航到 currentIndex+1 的 entryId", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr({
      currentIndex: 0,
      entries: [
        { id: 10, url: "a" },
        { id: 20, url: "b" },
      ],
    });
    await navigateHistory(dbg as never, 42, 1);
    expect(dbg.sendCommand).toHaveBeenCalledWith(42, "Page.navigateToHistoryEntry", {
      entryId: 20,
    });
  });

  it("先 attach(tid) 再发 CDP 命令", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr({
      currentIndex: 1,
      entries: [
        { id: 1, url: "a" },
        { id: 2, url: "b" },
      ],
    });
    await navigateHistory(dbg as never, 42, -1);
    expect(dbg.attach).toHaveBeenCalledWith(42);
  });

  it("back 边界(currentIndex=0): 抛 NO_EFFECT 且不调 navigateToHistoryEntry", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr({ currentIndex: 0, entries: [{ id: 10, url: "a" }] });
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    // 不用 toBeInstanceOf(VtxError):vi.resetModules() 使 page.ts 内的
    // VtxError 与此处 import 的不是同一构造器(模块重复)。Error 是全局唯一,
    // 加字符串 code(跨实例稳定)断言被测行为契约。
    expect(err).toBeInstanceOf(Error);
    expect((err as VtxError).code).toBe(VtxErrorCode.NO_EFFECT);
    const methods = dbg.sendCommand.mock.calls.map((c) => c[1]);
    expect(methods).not.toContain("Page.navigateToHistoryEntry");
  });

  it("forward 边界(currentIndex=末尾): 抛 NO_EFFECT", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr({
      currentIndex: 1,
      entries: [
        { id: 10, url: "a" },
        { id: 20, url: "b" },
      ],
    });
    const err = await navigateHistory(dbg as never, 42, 1).catch((e: unknown) => e);
    // 不用 toBeInstanceOf(VtxError):vi.resetModules() 使 page.ts 内的
    // VtxError 与此处 import 的不是同一构造器(模块重复)。Error 是全局唯一,
    // 加字符串 code(跨实例稳定)断言被测行为契约。
    expect(err).toBeInstanceOf(Error);
    expect((err as VtxError).code).toBe(VtxErrorCode.NO_EFFECT);
  });
});

describe("D-HIST-1: 浏览器拒绝恢复历史项 ⇒ 结构化 NO_EFFECT(不是裸 CDP 错误)", () => {
  const target = { id: 10, url: "chrome://newtab/" };

  it("拒绝恢复 ⇒ NO_EFFECT + recoverable:false + hint 指向 vortex_navigate", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr(
      { currentIndex: 1, entries: [target, { id: 20, url: "https://example.com/" }] },
      { navigateError: refusalError() },
    );
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as VtxError).code).toBe(VtxErrorCode.NO_EFFECT);
    expect((err as VtxError).extra?.recoverable).toBe(false);
    expect((err as VtxError).extra?.hint).toContain("vortex_navigate");
    // 走的是「拒绝分支」而不是「索引越界分支」：CDP 命令确实被调用过
    expect(dbg.sendCommand).toHaveBeenCalledWith(42, "Page.navigateToHistoryEntry", { entryId: 10 });
  });

  it("拒绝恢复 ⇒ 文案陈述「浏览器拒绝恢复该历史项」并带目标 URL", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr(
      { currentIndex: 1, entries: [target, { id: 20, url: "https://example.com/" }] },
      { navigateError: refusalError() },
    );
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/refus/i);
    expect((err as Error).message).toContain("chrome://newtab/");
  });

  it("目标不是内部页 ⇒ 不做「内部页」归因(不做无条件归因)", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr(
      { currentIndex: 1, entries: [{ id: 10, url: "https://a.test/" }, { id: 20, url: "https://b.test/" }] },
      { navigateError: refusalError() },
    );
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect((err as VtxError).code).toBe(VtxErrorCode.NO_EFFECT);
    expect((err as Error).message).toMatch(/refus/i);
    expect((err as Error).message).not.toMatch(/internal page/i);
  });

  it("forward 方向同样可翻译", async () => {
    const { navigateHistory } = await importPage();
    const dbg = mkDebuggerMgr(
      { currentIndex: 0, entries: [{ id: 20, url: "https://example.com/" }, target] },
      { navigateError: refusalError() },
    );
    const err = await navigateHistory(dbg as never, 42, 1).catch((e: unknown) => e);
    expect((err as VtxError).code).toBe(VtxErrorCode.NO_EFFECT);
    expect((err as VtxError).extra?.recoverable).toBe(false);
  });

  it("同 code 不同 message ⇒ 原样抛出(对象同一性)", async () => {
    const { navigateHistory } = await importPage();
    const original = refusalError("Not permitted");
    const dbg = mkDebuggerMgr(
      { currentIndex: 1, entries: [target, { id: 20, url: "https://example.com/" }] },
      { navigateError: original },
    );
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect(err).toBe(original);
  });

  it("不同 code 同 message ⇒ 原样抛出", async () => {
    const { navigateHistory } = await importPage();
    const original = refusalError("Not allowed", -32001);
    const dbg = mkDebuggerMgr(
      { currentIndex: 1, entries: [target, { id: 20, url: "https://example.com/" }] },
      { navigateError: original },
    );
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect(err).toBe(original);
  });

  it("非 JSON 文本 ⇒ 原样抛出", async () => {
    const { navigateHistory } = await importPage();
    const original = new Error("Not allowed");
    const dbg = mkDebuggerMgr(
      { currentIndex: 1, entries: [target, { id: 20, url: "https://example.com/" }] },
      { navigateError: original },
    );
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect(err).toBe(original);
  });

  it("getNavigationHistory 失败 ⇒ 原样抛出(不被翻译)", async () => {
    const { navigateHistory } = await importPage();
    const original = new Error("get history boom");
    const dbg = mkDebuggerMgr({ currentIndex: 0, entries: [] }, { historyError: original });
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect(err).toBe(original);
  });

  it("attach 失败 ⇒ 原样抛出(不被翻译)", async () => {
    const { navigateHistory } = await importPage();
    const original = new Error("attach boom");
    const dbg = mkDebuggerMgr({ currentIndex: 0, entries: [] }, { attachError: original });
    const err = await navigateHistory(dbg as never, 42, -1).catch((e: unknown) => e);
    expect(err).toBe(original);
  });
});

describe("page.back/forward 源码契约:改用 CDP 历史导航", () => {
  it("BACK/FORWARD 不再调用 chrome.tabs.goBack/goForward(注释提及不算)", () => {
    // 带左括号 = 实际调用;裸词出现在「为何弃用」的文档注释中是允许的。
    expect(PAGE_SRC).not.toMatch(/chrome\.tabs\.goBack\(/);
    expect(PAGE_SRC).not.toMatch(/chrome\.tabs\.goForward\(/);
  });

  it("使用 Page.getNavigationHistory + Page.navigateToHistoryEntry", () => {
    expect(PAGE_SRC).toMatch(/Page\.getNavigationHistory/);
    expect(PAGE_SRC).toMatch(/Page\.navigateToHistoryEntry/);
  });

  it("BACK/FORWARD handler 调用 navigateHistory", () => {
    expect(PAGE_SRC).toMatch(/navigateHistory\(/);
  });
});
