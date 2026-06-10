// I2: CapabilityDetector 在 chrome.debugger 不可用时返回 canUseCDP=false。
// 实现见 ../../src/adapter/detector.ts（T1.8 task 完成）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { capabilityDetector } from "../../src/adapter/detector";

declare global {
  // eslint-disable-next-line no-var
  var chrome: any;
}

describe("I2: CapabilityDetector fallback to native when CDP unavailable", () => {
  beforeEach(() => {
    // 重置 chrome.debugger mock
    globalThis.chrome = {
      debugger: undefined,
    };
  });

  it("chrome.debugger 完全不存在时 canUseCDP 返回 false", async () => {
    const ok = await capabilityDetector.canUseCDP(1);
    expect(ok).toBe(false);
  });

  it("chrome.debugger.attach 失败时 canUseCDP 返回 false", async () => {
    globalThis.chrome = {
      debugger: {
        attach: vi.fn((_target, _ver, cb) => {
          // 模拟权限拒绝
          (globalThis.chrome.runtime ??= {}).lastError = { message: "Permission denied" };
          cb?.();
        }),
        detach: vi.fn((_t, cb) => cb?.()),
      },
      runtime: { lastError: undefined },
    };
    const ok = await capabilityDetector.canUseCDP(1);
    expect(ok).toBe(false);
  });

  it("needsTrustedEvent 对 drag 永远返回 true", () => {
    expect(capabilityDetector.needsTrustedEvent("drag")).toBe(true);
  });

  it("needsTrustedEvent 对普通 click 返回 false", () => {
    expect(capabilityDetector.needsTrustedEvent("click", { tagName: "button" })).toBe(false);
  });

  // CDP-first 转正（2026-06-11）：传入 debuggerMgr 时探测改为 try-attach 留驻——
  // 探测成功即保持 attached（经 manager 记账，后续动作复用 session），
  // 不再「attach→立即 detach」（probe-detach 在非 trusted Chrome 会让 infobar 闪现，
  // 且 CDP-first 默认路径下紧随其后的动作本来就要再 attach）。
  describe("resident try-attach 模式（CDP-first 共享前置）", () => {
    function mkMgr(overrides: Partial<{ attach: unknown; isAttached: unknown }> = {}) {
      return {
        attach: vi.fn().mockResolvedValue(undefined),
        isAttached: vi.fn().mockReturnValue(false),
        ...overrides,
      };
    }

    it("传 debuggerMgr 且 attach 成功 → true，且不调用 chrome.debugger.detach（留驻）", async () => {
      const detachMock = vi.fn((_t: unknown, cb?: () => void) => cb?.());
      globalThis.chrome = {
        debugger: { attach: vi.fn(), detach: detachMock },
        runtime: { lastError: undefined },
      };
      const mgr = mkMgr();
      const ok = await capabilityDetector.canUseCDP(1, mgr as never);
      expect(ok).toBe(true);
      expect(mgr.attach).toHaveBeenCalledWith(1);
      expect(detachMock).not.toHaveBeenCalled();
      // 不绕过 manager 裸调 chrome.debugger.attach（记账必须经 manager）
      expect(globalThis.chrome.debugger.attach).not.toHaveBeenCalled();
    });

    it("已 attached 时 → true 且不重复 attach", async () => {
      globalThis.chrome = {
        debugger: { attach: vi.fn(), detach: vi.fn() },
        runtime: { lastError: undefined },
      };
      const mgr = mkMgr({ isAttached: vi.fn().mockReturnValue(true) });
      const ok = await capabilityDetector.canUseCDP(1, mgr as never);
      expect(ok).toBe(true);
      expect(mgr.attach).not.toHaveBeenCalled();
    });

    it("mgr.attach 拒绝（DevTools 独占/策略禁用）→ false 不抛", async () => {
      globalThis.chrome = {
        debugger: { attach: vi.fn(), detach: vi.fn() },
        runtime: { lastError: undefined },
      };
      const mgr = mkMgr({
        attach: vi.fn().mockRejectedValue(new Error("Another debugger is already attached")),
      });
      const ok = await capabilityDetector.canUseCDP(1, mgr as never);
      expect(ok).toBe(false);
    });

    it("chrome.debugger 不存在时即使传 mgr 也返回 false（不触碰 mgr.attach）", async () => {
      globalThis.chrome = { debugger: undefined };
      const mgr = mkMgr();
      const ok = await capabilityDetector.canUseCDP(1, mgr as never);
      expect(ok).toBe(false);
      expect(mgr.attach).not.toHaveBeenCalled();
    });

    it("mgr.attach 挂起超过 1s budget → false（不无限等待）", async () => {
      vi.useFakeTimers();
      try {
        globalThis.chrome = {
          debugger: { attach: vi.fn(), detach: vi.fn() },
          runtime: { lastError: undefined },
        };
        const mgr = mkMgr({ attach: vi.fn().mockReturnValue(new Promise(() => {})) });
        const promise = capabilityDetector.canUseCDP(1, mgr as never);
        await vi.advanceTimersByTimeAsync(1500);
        expect(await promise).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // 覆盖 commit 2d0062b（P1 fix）：timeout 后 attach 仍成功必须 detach 清理，避免 debugger 残留泄漏
  describe("timeout-late-attach race（commit 2d0062b 回归保护）", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("timeout 后 attach 才成功 callback 时 canUseCDP 返 false 且 detach 调用一次", async () => {
      const attachCallbacks: Array<() => void> = [];
      const detachMock = vi.fn((_t: unknown, cb?: () => void) => cb?.());
      globalThis.chrome = {
        debugger: {
          attach: vi.fn((_target: unknown, _ver: unknown, cb: () => void) => {
            // 不立即触发 callback，而是放入队列等待手动激活（模拟 attach 慢于 timeout）
            attachCallbacks.push(cb);
          }),
          detach: detachMock,
        },
        runtime: { lastError: undefined },
      };

      // 启动探测；不 await，先让 timer 推进
      const promise = capabilityDetector.canUseCDP(1);

      // 推进时间触发 timeout（1000ms budget）
      await vi.advanceTimersByTimeAsync(1500);

      // 此时 promise 应已 resolve(false)（timer 提前触发）
      const result = await promise;
      expect(result).toBe(false);

      // 模拟 attach 在 timeout 之后才成功 callback（lastError 缺省即"成功"）
      expect(attachCallbacks.length).toBe(1);
      attachCallbacks[0]();

      // 关键断言：detach 被调用一次清理（修复 commit 2d0062b 之前会泄漏 attached）
      expect(detachMock).toHaveBeenCalledTimes(1);
    });

    it("timeout 后 attach 失败 callback 时不调 detach（无泄漏可清）", async () => {
      const attachCallbacks: Array<() => void> = [];
      const detachMock = vi.fn((_t: unknown, cb?: () => void) => cb?.());
      globalThis.chrome = {
        debugger: {
          attach: vi.fn((_target: unknown, _ver: unknown, cb: () => void) => {
            attachCallbacks.push(cb);
          }),
          detach: detachMock,
        },
        runtime: { lastError: undefined },
      };

      const promise = capabilityDetector.canUseCDP(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await promise).toBe(false);

      // attach 在 timeout 后才 callback，但带 lastError → 实际未 attached，无需 detach
      (globalThis.chrome.runtime ??= {}).lastError = { message: "tab closed" };
      attachCallbacks[0]();

      expect(detachMock).not.toHaveBeenCalled();
    });
  });
});
