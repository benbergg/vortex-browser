import { describe, it, expect } from "vitest";
import { formatDispatchError } from "../src/lib/dispatch-error.js";

describe("formatDispatchError：hint 三层兜底", () => {
  it("远端带 hint 时优先用它", () => {
    const s = formatDispatchError({ code: "NO_EFFECT", message: "nothing happened", hint: "远端给的" });
    expect(s).toBe("Error [NO_EFFECT]: nothing happened\nHint: 远端给的");
  });

  it("ELEMENT_NOT_FOUND 无远端 hint 时回落 DEFAULT_ERROR_META", () => {
    const s = formatDispatchError({ code: "ELEMENT_NOT_FOUND", message: "Element not found: div > table" });
    expect(s).toContain("Error [ELEMENT_NOT_FOUND]: Element not found: div > table");
    // 这是真站 dogfood 里被序列丢掉的那句，调用方靠它才知道下一步该做什么
    expect(s).toContain("call vortex_observe");
  });

  it("STALE_SNAPSHOT 无远端 hint 时用中文兜底", () => {
    const s = formatDispatchError({ code: "STALE_SNAPSHOT", message: "expired" });
    expect(s).toContain("请重新调用 vortex_observe");
  });

  it("TIMEOUT 且 lastReason=NOT_ATTACHED 时追加第二条 hint（surface code 掩盖了根因）", () => {
    const s = formatDispatchError({
      code: "TIMEOUT",
      message: "timed out",
      context: { extras: { lastReason: "NOT_ATTACHED" } },
    });
    expect(s).toContain("Hint (lastReason=NOT_ATTACHED):");
  });

  it("既无远端 hint 也无 meta 时只出正文，不编造", () => {
    const s = formatDispatchError({ code: "NOT_A_REAL_CODE", message: "boom" });
    expect(s).toBe("Error [NOT_A_REAL_CODE]: boom");
  });
});
