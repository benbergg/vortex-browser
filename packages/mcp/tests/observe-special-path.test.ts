import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression for the v0.6 dogfood Bug C: PR #4 renamed the public
// vortex_observe tool's action from "observe.snapshot" to "L4.observe", but
// the server.ts special branch still tested the old string. As a result
// every call skipped the branch, activeSnapshotId stayed null, every
// subsequent @eN ref threw STALE_SNAPSHOT, and observe responses came back
// as ~60 KB raw JSON instead of compact format.
//
// We exercise the route via the now-exported handleCallTool, mocking the
// downstream sendRequest so we can assert (a) the action sent to the
// extension is exactly "observe.snapshot" regardless of the public
// toolDef.action name, (b) compact rendering wins by default, (c) a
// follow-up vortex_act with `@eN` is translated into selector/index params
// instead of bouncing with STALE_SNAPSHOT.

vi.mock("../src/client.js", () => ({
  sendRequest: vi.fn(),
}));

vi.mock("../src/lib/event-store.js", () => ({
  eventStore: {
    drain: vi.fn(() => []),
    subscribe: vi.fn(() => "sub_test"),
    unsubscribe: vi.fn(() => true),
  },
}));

describe("vortex_observe special path (Bug C regression)", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
  });

  it("dispatches the literal 'observe.snapshot' action even though toolDef.action is 'L4.observe'", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: {
        snapshotId: "snap_test_1",
        url: "https://example.com",
        elements: [],
      },
    } as any);

    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: {
        name: "vortex_observe",
        arguments: { scope: "viewport", filter: "interactive" },
      },
    });

    expect(sendRequest).toHaveBeenCalledTimes(1);
    const [action, params] = vi.mocked(sendRequest).mock.calls[0];
    expect(action).toBe("observe.snapshot");
    // Reshape: scope=viewport → viewport='visible', filter passes through,
    // detail defaults to compact via the format field.
    expect((params as Record<string, unknown>).viewport).toBe("visible");
    expect((params as Record<string, unknown>).filter).toBe("interactive");
    expect((params as Record<string, unknown>).format).toBe("compact");
  });

  it("scope=full reshapes to viewport='full'", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: { snapshotId: "snap_test_2", url: "", elements: [] },
    } as any);

    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: { name: "vortex_observe", arguments: { scope: "full" } },
    });

    const [, params] = vi.mocked(sendRequest).mock.calls[0];
    expect((params as Record<string, unknown>).viewport).toBe("full");
  });

  // Bug F transit-path regression: server.ts:306 currently destructures
  // { scope, filter, tabId, timeout, ...rest } and frames falls through via
  // `rest`. If a refactor names `frames` explicitly in the destructure and
  // forgets to forward it into `next`, schemas-public still exposes the
  // param (I15 passes) but the value never reaches the extension — the
  // exact symmetric failure mode of Bug F itself.
  it("frames param is forwarded to extension (Bug F transit-path lock)", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: { snapshotId: "snap_test_3", url: "", elements: [] },
    } as any);

    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: {
        name: "vortex_observe",
        arguments: { scope: "viewport", frames: "all-permitted" },
      },
    });

    const [, params] = vi.mocked(sendRequest).mock.calls[0];
    expect((params as Record<string, unknown>).frames).toBe("all-permitted");
  });

  // 链路锁:extension 的 meta.degraded 必须一路活到 compact 文本。special path 若在
  // reshape 时漏传 meta,渲染层的 buildDegradedNote 拿不到数据 —— 单测各自绿、整条
  // 特性静默失效(与 Bug F transit-path 同构)。
  it("meta.degraded 透传到 compact 输出(scan-budget transit-path lock)", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: {
        snapshotId: "snap_degraded_1",
        url: "https://example.com",
        elements: [{ index: 0, tag: "button", role: "button", name: "OK", frameId: 0 }],
        meta: { degraded: { timedOutFrames: [190] } },
      },
    } as any);

    const { handleCallTool } = await import("../src/server.js");
    const res = await handleCallTool({
      params: { name: "vortex_observe", arguments: { scope: "viewport" } },
    });

    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("# degraded:");
    expect(text).toContain("190");
  });

  it("subsequent vortex_act with @eN ref reuses the activeSnapshotId set by observe (no STALE_SNAPSHOT)", async () => {
    const { sendRequest } = await import("../src/client.js");
    // observe → returns snapshotId
    vi.mocked(sendRequest).mockResolvedValueOnce({
      result: { snapshotId: "snap_active_1", url: "", elements: [] },
    } as any);
    // act → success payload
    vi.mocked(sendRequest).mockResolvedValueOnce({
      result: { success: true, element: { tag: "button", text: "Star" } },
    } as any);

    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: { name: "vortex_observe", arguments: { scope: "viewport" } },
    });
    const actResult = await handleCallTool({
      params: {
        name: "vortex_act",
        arguments: { target: "@e54", action: "click" },
      },
    });

    expect(actResult.isError).not.toBe(true);
    const [actAction, actParams] = vi.mocked(sendRequest).mock.calls[1];
    expect(actAction).toBe("dom.click");
    // ref-parser + server.ts target translation should populate index +
    // snapshotId from the observe-tracked activeSnapshotId, not throw
    // STALE_SNAPSHOT.
    expect((actParams as Record<string, unknown>).index).toBe(54);
    expect((actParams as Record<string, unknown>).snapshotId).toBe("snap_active_1");
    expect((actParams as Record<string, unknown>).target).toBeUndefined();
  });
});
