// packages/extension/src/lib/debugger-manager.ts

type CdpEventCallback = (tabId: number, method: string, params: unknown) => void;

interface AttachedTab {
  domains: Set<string>; // 已启用的 CDP domain（"Runtime", "Network" 等）
}

/**
 * 管理 chrome.debugger session 的复用、attach/detach 生命周期。
 *
 * 设计要点：
 * - 同一个 tab 只 attach 一次，多个 domain 共享 session
 * - 通过 enableDomain/disableDomain 管理 CDP domain 启停
 * - 所有 domain 都 disable 后自动 detach（移除调试横幅）
 * - onDetach 时清理所有状态
 */
export class DebuggerManager {
  private attachedTabs = new Map<number, AttachedTab>();
  private eventCallbacks: CdpEventCallback[] = [];

  constructor() {
    // 全局事件监听
    chrome.debugger.onEvent.addListener(
      (source: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (source.tabId == null) return;
        for (const cb of this.eventCallbacks) {
          try {
            cb(source.tabId, method, params);
          } catch (err) {
            console.error("[debugger-manager] event callback error:", err);
          }
        }
      },
    );

    // 检测用户手动关闭调试横幅 / tab 关闭
    chrome.debugger.onDetach.addListener(
      (source: chrome.debugger.Debuggee, reason: string) => {
        if (source.tabId != null) {
          console.warn(
            `[debugger-manager] detached from tab ${source.tabId}: ${reason}`,
          );
          this.attachedTabs.delete(source.tabId);
        }
      },
    );

    // tab 关闭时清理
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.attachedTabs.delete(tabId);
    });
  }

  /**
   * 注册 CDP 事件回调。
   * 所有 attach 的 tab 的事件都会触发此回调。
   */
  onEvent(callback: CdpEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  /**
   * 注销 CDP 事件回调。
   */
  offEvent(callback: CdpEventCallback): void {
    const idx = this.eventCallbacks.indexOf(callback);
    if (idx >= 0) this.eventCallbacks.splice(idx, 1);
  }

  /**
   * 确保 tab 已 attach debugger（不启用任何 domain）。
   * 适用于 Input 等无需 enable 命令的 domain。
   */
  async attach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      this.attachedTabs.set(tabId, { domains: new Set() });
      // SPIKE(2026-06-09 京东后台 click 5s):让后台标签的渲染器/输入处理不被
      // Chrome 节流。Playwright 用启动参数,vortex 连用户现有 Chrome 只能运行时
      // CDP。候选:focus 模拟。best-effort,失败不影响 attach。
      try {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch {
        // 某些 Chrome/页面不支持,忽略
      }
    }
  }

  /**
   * 确保 tab 已 attach debugger，并启用指定 domain。
   * 如果已经 attach + enable 过，直接返回。
   */
  async enableDomain(tabId: number, domain: string): Promise<void> {
    // 确保已 attach
    if (!this.attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      this.attachedTabs.set(tabId, { domains: new Set() });
    }

    const tab = this.attachedTabs.get(tabId)!;

    // 确保 domain 已启用
    if (!tab.domains.has(domain)) {
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
      tab.domains.add(domain);
    }
  }

  /**
   * 禁用指定 domain。如果 tab 上所有 domain 都禁用了，自动 detach。
   */
  async disableDomain(tabId: number, domain: string): Promise<void> {
    const tab = this.attachedTabs.get(tabId);
    if (!tab) return;

    if (tab.domains.has(domain)) {
      try {
        await chrome.debugger.sendCommand({ tabId }, `${domain}.disable`);
      } catch {
        // domain 可能已经被禁用
      }
      tab.domains.delete(domain);
    }

    // 所有 domain 都禁用后 detach
    if (tab.domains.size === 0) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // 可能已经被 detach
      }
      this.attachedTabs.delete(tabId);
    }
  }

  /**
   * 向 debugger 发送 CDP 命令。
   */
  async sendCommand(
    tabId: number,
    method: string,
    params?: object,
  ): Promise<unknown> {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  /**
   * 检查 tab 是否已 attach。
   */
  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }

  /**
   * 获取所有已 attach 的 tab ID。
   */
  getAttachedTabs(): number[] {
    return Array.from(this.attachedTabs.keys());
  }
}
