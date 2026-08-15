/**
 * Author: qingwa
 * Description: 祖先命中的话术必须与「被浮层盖住」区分——修法完全不同:
 *   浮层要关掉,祖先裁剪要滚动容器/换目标,让调用方去找浮层是死路。
 */
import { describe, it, expect } from "vitest";
import { buildActionabilityTimeoutMessage } from "../src/action/auto-wait.js";

describe("祖先命中话术", () => {
  it("hitKind=ancestor → 点名祖先并给裁剪/pointer-events 处方", () => {
    const msg = buildActionabilityTimeoutMessage({
      timeout: 2000, lastReason: "OBSCURED",
      lastExtras: { blocker: "div#track-wrap", hitKind: "ancestor", modalBlocked: false },
    });
    expect(msg).toContain("div#track-wrap");
    expect(msg).toContain("ancestor");
    expect(msg).not.toContain("dismiss");
  });

  it("hitKind=overlay → 保持既有「被谁盖住」话术（回归保护）", () => {
    const msg = buildActionabilityTimeoutMessage({
      timeout: 2000, lastReason: "OBSCURED",
      lastExtras: { blocker: "div#mask", hitKind: "overlay", modalBlocked: false },
    });
    expect(msg).toContain("covered by <div#mask>");
  });
});
