import {
  VtxEventType,
  eventLevelOf,
  type VtxEventLevel,
} from "@vortex-browser/shared";
import type { NativeMessagingClient } from "../lib/native-messaging.js";

interface EmitOpts {
  tabId?: number;
  frameId?: number;
  level?: VtxEventLevel;
}

interface BatchEntry {
  type: string;
  data: unknown;
  tabId?: number;
  frameId?: number;
  level: VtxEventLevel;
  time: number;
}

/**
 * 事件分发器 · 三级节流（F10）：
 * - urgent：立即 send，零延迟
 * - notice：200ms 批量 flush，不合并（保留每条事件结构）
 * - info：1000ms 批量 flush + 同 (type, tabId, frameId) 合并
 *   （data 包装成 { mergedCount, firstAt, lastAt, samples }，
 *   最多保留 3 条 sample 原始 data）
 */
export class EventDispatcher {
  private noticeBuffer: BatchEntry[] = [];
  private infoBuffer: BatchEntry[] = [];
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private infoTimer: ReturnType<typeof setTimeout> | null = null;

  // 可覆盖窗口（便于测试）
  readonly NOTICE_FLUSH_MS: number;
  readonly INFO_FLUSH_MS: number;
  readonly INFO_SAMPLE_LIMIT = 3;

  constructor(
    private nm: NativeMessagingClient,
    opts: { noticeFlushMs?: number; infoFlushMs?: number } = {},
  ) {
    this.NOTICE_FLUSH_MS = opts.noticeFlushMs ?? 200;
    this.INFO_FLUSH_MS = opts.infoFlushMs ?? 1000;
  }

  emit(type: string, data: unknown, opts: EmitOpts = {}): void {
    const level = opts.level ?? eventLevelOf(type);
    const entry: BatchEntry = {
      type,
      data,
      tabId: opts.tabId,
      frameId: opts.frameId,
      level,
      time: Date.now(),
    };

    if (level === "urgent") {
      this.sendEntry(entry);
      return;
    }

    if (level === "notice") {
      this.noticeBuffer.push(entry);
      if (this.noticeTimer === null) {
        this.noticeTimer = setTimeout(() => this.flushNotice(), this.NOTICE_FLUSH_MS);
      }
      return;
    }

    // info
    this.infoBuffer.push(entry);
    if (this.infoTimer === null) {
      this.infoTimer = setTimeout(() => this.flushInfo(), this.INFO_FLUSH_MS);
    }
  }

  /**
   * 强制立即 flush 所有 buffer（进程退出前 / 测试 / vortex_events_drain 工具用）。
   * 返回本次 flush 实际发送的事件条数（合并后）。
   */
  flushAll(): { notice: number; info: number } {
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    if (this.infoTimer !== null) {
      clearTimeout(this.infoTimer);
      this.infoTimer = null;
    }
    const notice = this.flushNotice();
    const info = this.flushInfo();
    return { notice, info };
  }

  private flushNotice(): number {
    const batch = this.noticeBuffer;
    this.noticeBuffer = [];
    this.noticeTimer = null;
    for (const entry of batch) this.sendEntry(entry);
    return batch.length;
  }

  private flushInfo(): number {
    const batch = this.infoBuffer;
    this.infoBuffer = [];
    this.infoTimer = null;

    // 按 type + tabId + frameId 合并
    const merged = new Map<
      string,
      {
        firstEntry: BatchEntry;
        count: number;
        firstAt: number;
        lastAt: number;
        samples: unknown[];
      }
    >();
    for (const e of batch) {
      const key = `${e.type}::${e.tabId ?? "-"}::${e.frameId ?? "-"}`;
      const existing = merged.get(key);
      if (existing) {
        existing.count++;
        existing.lastAt = e.time;
        if (existing.samples.length < this.INFO_SAMPLE_LIMIT) {
          existing.samples.push(e.data);
        }
      } else {
        merged.set(key, {
          firstEntry: e,
          count: 1,
          firstAt: e.time,
          lastAt: e.time,
          samples: [e.data],
        });
      }
    }

    let sent = 0;
    for (const group of merged.values()) {
      if (group.count === 1) {
        this.sendEntry(group.firstEntry);
      } else {
        this.sendEntry({
          ...group.firstEntry,
          data: {
            mergedCount: group.count,
            firstAt: group.firstAt,
            lastAt: group.lastAt,
            samples: group.samples,
            note: `${group.count} events of "${group.firstEntry.type}" merged over ${this.INFO_FLUSH_MS}ms window`,
          },
        });
      }
      sent++;
    }
    return sent;
  }

  private sendEntry(entry: BatchEntry): void {
    this.nm.send({
      type: "event",
      event: entry.type,
      data: entry.data,
      tabId: entry.tabId,
      frameId: entry.frameId,
      level: entry.level,
    });
  }
}

/**
 * 注册 chrome.* 层的事件监听到 dispatcher。
 * 页面内事件（console/network 过滤、form submit、DOM mutation 等）
 * 在各 handler 内通过依赖注入的 dispatcher 上报。
 */
export function registerEventSources(dispatcher: EventDispatcher): void {
  chrome.tabs.onActivated.addListener((info) => {
    dispatcher.emit(
      VtxEventType.USER_SWITCHED_TAB,
      { windowId: info.windowId },
      { tabId: info.tabId },
    );
  });

  chrome.tabs.onCreated.addListener((tab) => {
    dispatcher.emit(
      VtxEventType.USER_OPENED_TAB,
      { openerTabId: tab.openerTabId },
      { tabId: tab.id },
    );
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    dispatcher.emit(
      VtxEventType.USER_CLOSED_TAB,
      { windowId: removeInfo.windowId, isWindowClosing: removeInfo.isWindowClosing },
      { tabId },
    );
  });

  chrome.webNavigation.onCompleted.addListener((details) => {
    // 仅主 frame 的导航完成才作为"页面跳转"事件
    if (details.frameId !== 0) return;
    dispatcher.emit(
      VtxEventType.PAGE_NAVIGATED,
      { url: details.url },
      { tabId: details.tabId },
    );
  });
}
