import { describe, it, expect } from "vitest";
import { VtxEventType, EVENT_LEVEL, eventLevelOf } from "../src/events.js";

describe("VtxEventType enum", () => {
  it("defines 12 event types", () => {
    expect(Object.keys(VtxEventType)).toHaveLength(12);
  });

  it("each value follows namespace.event_name convention", () => {
    for (const v of Object.values(VtxEventType)) {
      expect(v).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("exposes core urgent events", () => {
    expect(VtxEventType.USER_SWITCHED_TAB).toBe("user.switched_tab");
    expect(VtxEventType.USER_CLOSED_TAB).toBe("user.closed_tab");
    expect(VtxEventType.DIALOG_OPENED).toBe("dialog.opened");
    expect(VtxEventType.DOWNLOAD_COMPLETED).toBe("download.completed");
  });
});

describe("EVENT_LEVEL mapping", () => {
  it("maps user / dialog / download / extension events to 'urgent'", () => {
    expect(EVENT_LEVEL["user.switched_tab"]).toBe("urgent");
    expect(EVENT_LEVEL["user.closed_tab"]).toBe("urgent");
    expect(EVENT_LEVEL["dialog.opened"]).toBe("urgent");
    expect(EVENT_LEVEL["download.completed"]).toBe("urgent");
    expect(EVENT_LEVEL["extension.disconnected"]).toBe("urgent");
  });

  it("maps navigation / errors / form to 'notice'", () => {
    expect(EVENT_LEVEL["user.opened_tab"]).toBe("notice");
    expect(EVENT_LEVEL["page.navigated"]).toBe("notice");
    expect(EVENT_LEVEL["console.error"]).toBe("notice");
    expect(EVENT_LEVEL["network.error_detected"]).toBe("notice");
    expect(EVENT_LEVEL["form.submitted"]).toBe("notice");
  });

  it("maps high-volume debug signals to 'info'", () => {
    expect(EVENT_LEVEL["dom.mutated"]).toBe("info");
    expect(EVENT_LEVEL["network.request"]).toBe("info");
  });
});

describe("eventLevelOf", () => {
  it("returns mapped level for known events", () => {
    expect(eventLevelOf("user.switched_tab")).toBe("urgent");
    expect(eventLevelOf("page.navigated")).toBe("notice");
    expect(eventLevelOf("dom.mutated")).toBe("info");
  });

  it("returns 'info' for unknown events (legacy compatibility)", () => {
    expect(eventLevelOf("console.message")).toBe("info");
    expect(eventLevelOf("network.requestStart")).toBe("info");
    expect(eventLevelOf("file.downloadComplete")).toBe("info");
    expect(eventLevelOf("something.totally.unknown")).toBe("info");
  });

  it("returns 'info' for empty string (defensive default)", () => {
    expect(eventLevelOf("")).toBe("info");
  });
});
