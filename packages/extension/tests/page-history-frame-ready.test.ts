import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

/**
 * 回归锁：vortex_history / vortex_forward 之后紧接着的第一次页面注入不能撞上
 * frame 交接窗口（Round 3，2026-06-11）。
 *
 * 现象：back 之后马上 vortex_evaluate → "Frame with ID 0 was removed."
 *   （实测 20 轮 back → 立即 evaluate：9/20 轮首次注入即失败；resp→ready 中位
 *   111.6ms / max 266ms）。根因：history 恢复提交后渲染进程销毁旧 frame、换上
 *   新 frame，交接窗口内任何 chrome.scripting.executeScript 注入都会失败；而
 *   handler 只等 tab 级 "complete"（实测命令后 ~33ms 就到），远早于 frame 交接
 *   完成，于是 history 先返回、调用方紧接着的操作就炸。
 *
 * 修复：back/forward 在返回前等主 frame **且新文档**已接管
 *   （waitForMainFrameReady）：只看"能注入"不够——交接窗口前半段旧 frame 照样
 *   能注入，必须比对文档身份（href / timeOrigin）；预算耗尽抛 PAGE_NOT_READY，
 *   不静默当成功。
 *
 *   还要等 frame **稳定**：Chrome 的 history 恢复先把文档塞进临时 frame、随后把
 *   该 frame 换掉。探针命中"恢复中的文档"时身份已经是新的，但那个 frame 马上
 *   要死——只判身份变化时仍有 ~2.8% 的轮次在 ~50ms 后报 "Frame was removed"。
 *   所以判据是"同一个 frameId + documentId 连续稳定存在 confirmMs"。
 */

let executeScriptMock: Mock;

function installChrome(scriptingImpl: () => Promise<unknown>) {
  executeScriptMock = vi.fn().mockImplementation(scriptingImpl);
  (globalThis as any).chrome = {
    scripting: { executeScript: executeScriptMock },
    tabs: { onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
  };
}

async function importPage() {
  vi.resetModules();
  return import("../src/handlers/page.js");
}

/** 交接窗口内的典型报错：旧 frame 已移除。 */
const HANDOVER_ERR = "Frame with ID 0 was removed.";

const OLD_DOC = { href: "http://x/old", timeOrigin: 1000 };
const NEW_DOC = { href: "http://x/new", timeOrigin: 2000 };

function ok(doc: { href: string; timeOrigin: number }, frameId = 7, documentId = "doc-7") {
  return Promise.resolve([{ result: doc, frameId, documentId }]);
}

describe("history 之后 frame 交接门控（Round 3）", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("交接未完成 → 继续等，直到新文档接管", async () => {
    let call = 0;
    installChrome(() => {
      call += 1;
      // 第 1 次探到旧文档（交接还没走完，旧 frame 照样能注入）
      if (call === 1) return ok(OLD_DOC);
      // 第 2 次撞上交接窗口
      if (call === 2) return Promise.reject(new Error(HANDOVER_ERR));
      return ok(NEW_DOC);
    });
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 2000, 0)).resolves.toBeUndefined();
    expect(executeScriptMock).toHaveBeenCalledTimes(3);
  });

  it("文档身份已变 → 不必等交接错误出现，但仍要等 frame 稳定窗口", async () => {
    installChrome(() => ok(NEW_DOC));
    const { waitForMainFrameReady } = await importPage();
    const t0 = Date.now();
    await expect(waitForMainFrameReady(1, OLD_DOC, 2000, 40)).resolves.toBeUndefined();
    // 稳定窗口没到之前不能放行：至少探第二次，且耗时不少于窗口本身。
    expect(executeScriptMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });

  it("URL 相同但 timeOrigin 变了（重新加载同一 URL）→ 放行", async () => {
    installChrome(() => ok({ href: OLD_DOC.href, timeOrigin: 2000 }));
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 2000, 0)).resolves.toBeUndefined();
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
  });

  it("探针既不报错也不回结果（交接窗口）→ 不当成「永久失败」也不当成「已换掉」，继续等", async () => {
    let call = 0;
    installChrome(() => {
      call += 1;
      if (call === 1) return Promise.resolve([]);
      if (call === 2) return Promise.resolve([{ result: OLD_DOC }]);
      return ok(NEW_DOC);
    });
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 2000, 0)).resolves.toBeUndefined();
    expect(executeScriptMock).toHaveBeenCalledTimes(3);
  });

  it("只有 execution context was destroyed（不能证明 frame 已销毁）→ 不得据此放行", async () => {
    let call = 0;
    installChrome(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("Execution context was destroyed."));
      if (call === 2) return ok(OLD_DOC);
      return ok(NEW_DOC);
    });
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 2000, 0)).resolves.toBeUndefined();
    expect(executeScriptMock).toHaveBeenCalledTimes(3);
  });

  it("同一文档但 frame 被换掉（frameId 变了）→ 不得在换掉之前放行", async () => {
    let call = 0;
    installChrome(() => {
      call += 1;
      // 前两次命中"恢复中的临时 frame"，之后 frame 被换成新的那个。
      if (call === 1) return ok(NEW_DOC, 7, "doc-restored");
      if (call === 2) return ok(NEW_DOC, 9, "doc-final");
      return ok(NEW_DOC, 9, "doc-final");
    });
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 2000, 40)).resolves.toBeUndefined();
    // 必须观察到 frame 换代之后还要再稳一段，才算放行。
    expect(executeScriptMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("永久性错误（该页面本来就不支持注入）→ 立即返回，不重试也不抛", async () => {
    installChrome(() =>
      Promise.reject(
        new Error(
          "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
        ),
      ),
    );
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 2000, 0)).resolves.toBeUndefined();
    expect(executeScriptMock).toHaveBeenCalledTimes(1);
  });

  it("交接一直没完成 → 预算耗尽抛 PAGE_NOT_READY（不静默当成功）", async () => {
    installChrome(() => Promise.reject(new Error(HANDOVER_ERR)));
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 60, 0)).rejects.toThrow(/not ready/i);
  });

  it("探针挂住（页面还忙）→ 预算耗尽抛 PAGE_NOT_READY（不静默返回）", async () => {
    installChrome(() => new Promise(() => {}));
    const { waitForMainFrameReady } = await importPage();
    await expect(waitForMainFrameReady(1, OLD_DOC, 600, 0)).rejects.toThrow(/not ready/i);
  });
});
