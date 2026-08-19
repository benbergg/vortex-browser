import { describe, it, expect, vi, beforeEach } from "vitest";
import { withDiagnosis } from "@vortex-browser/shared";

/**
 * Description: CDP 被占降级时，fingerprint 的 drift 证据不能随自陈信封一起丢掉。
 *
 * 降级结果被 withDiagnosis 包成 {__vtxDiagnosis, value}；fingerprint 块若仍读未拆包的
 * resp.result，extractSignals 从信封上读不到任何信号（drift 恒 null，看起来「干净」），
 * 且 fp/drift 被写进随后丢弃的信封对象。最需要证据的那条路径反而零证据。
 */
vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: { drain: vi.fn(() => []), subscribe: vi.fn(() => "sub_test"), unsubscribe: vi.fn(() => true) },
}));

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

describe("降级的 act 结果仍带 fingerprint 证据", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
  });

  it("record 模式：降级信封里的 effect 仍被采成 fingerprint", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: withDiagnosis(
        {
          success: true,
          degraded: "cdp-busy-synthetic",
          effect: { domMutations: 3, urlChanged: false },
        },
        "Degraded to a synthetic click: chrome.debugger is held by another client",
      ),
    } as never);
    const { handleCallTool } = await import("../src/server.js");

    const res = await handleCallTool({
      params: {
        name: "vortex_act",
        arguments: {
          target: ".btn",
          action: "click",
          useRealMouse: true,
          options: { fingerprint: { mode: "record" } },
        },
      },
    });

    const text = textOf(res);
    // 自陈仍独立成块，同时 fingerprint 字段挂在被渲染的载荷上（而非被丢弃的信封上）
    expect(text).toContain("cdp-busy-synthetic");
    expect(text).toContain("fingerprint");
    // 信封的内部键不该泄漏到渲染层
    expect(text).not.toContain("__vtxDiagnosis");
  });
});
