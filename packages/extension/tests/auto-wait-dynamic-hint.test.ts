import { describe, it, expect, vi, beforeEach } from "vitest";
const checkMock = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...a: unknown[]) => checkMock(...a),
}));
import { waitActionable } from "../src/action/auto-wait.js";

describe("B3 终态动态 SPA 指引", () => {
  beforeEach(() => vi.clearAllMocks());
  it("NOT_ATTACHED 超时终态 message 含 observe/evaluate 套路", async () => {
    checkMock.mockResolvedValue({ ok: false, reason: "NOT_ATTACHED" });
    try {
      await waitActionable(1, undefined, "#stale", { timeout: 200 });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/observe/i);
      expect(e.message).toMatch(/evaluate/i);
    }
  });
});
