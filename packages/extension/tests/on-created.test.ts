/**
 * Author: qingwa
 * Description: Verifies tab creation events preserve opener ownership metadata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventDispatcher, registerEventSources } from "../src/events/dispatcher.js";

describe("tabs.onCreated event source", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("emits USER_OPENED_TAB with openerTabId", () => {
    const onCreated = { addListener: vi.fn() };
    vi.stubGlobal("chrome", {
      tabs: {
        onActivated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onCreated,
      },
      webNavigation: { onCompleted: { addListener: vi.fn() } },
    });
    const send = vi.fn();
    const dispatcher = new EventDispatcher({ send } as never);
    registerEventSources(dispatcher);

    const listener = onCreated.addListener.mock.calls[0][0] as (tab: chrome.tabs.Tab) => void;
    listener({ id: 42, openerTabId: 7 } as chrome.tabs.Tab);
    vi.advanceTimersByTime(200);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      event: "user.opened_tab",
      tabId: 42,
      data: { openerTabId: 7 },
      level: "notice",
    }));
  });
});
