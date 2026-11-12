import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_TOOLS } from "../src/tools/schemas-public.js";

vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: { drain: vi.fn(() => []), subscribe: vi.fn(() => "sub_test"), unsubscribe: vi.fn(() => true) },
}));

const hash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 4);
const snapshot = (id: string) => ({ result: { snapshotId: id, url: "https://x/", elements: [
  { index: 0, frameId: 0, tag: "button", role: "button", name: "Inside" },
] } });

beforeEach(async () => {
  const { sendRequest } = await import("../src/client.js");
  vi.mocked(sendRequest).mockReset();
});

describe("vortex_observe target public contract", () => {
  it("exposes pagination and forwards a cursor without capture parameters", async () => {
    const schema = PUBLIC_TOOLS.find((tool) => tool.name === "vortex_observe")!.schema as any;
    expect(schema.properties.paginate).toBeDefined();
    expect(schema.properties.cursor).toBeDefined();
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValueOnce({ result: { ...snapshot("pages").result, nextCursor: "snap_abc_1:80" } } as never)
      .mockResolvedValueOnce(snapshot("pages") as never);
    const { handleCallTool } = await import("../src/server.js");
    const first = await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42, paginate: true } } });
    expect((first.content[0] as { text: string }).text).toContain("snap_abc_1:80");
    await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42, cursor: "snap_abc_1:80" } } });
    expect(vi.mocked(sendRequest).mock.calls[1][1]).toEqual({ cursor: "snap_abc_1:80" });
  });
  it("advertises an optional target", () => {
    const schema = PUBLIC_TOOLS.find((tool) => tool.name === "vortex_observe")!.schema as any;
    expect(schema.properties.target).toBeDefined();
    expect(schema.required ?? []).not.toContain("target");
  });

  it("resolves the old ref before the scoped snapshot, rejects it afterward, and accepts the new ref", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValueOnce(snapshot("prior") as never)
      .mockResolvedValueOnce(snapshot("scoped") as never)
      .mockResolvedValueOnce({ result: { success: true } } as never);
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42 } } });
    const scoped = await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42, target: `@${hash("prior")}:e0` } } });
    expect(scoped.isError).not.toBe(true);
    const params = vi.mocked(sendRequest).mock.calls[1][1] as Record<string, unknown>;
    expect(params).toMatchObject({ index: 0, snapshotId: "prior" });
    expect(params.target).toBeUndefined();
    const old = await handleCallTool({ params: { name: "vortex_act", arguments: { tabId: 42, target: `@${hash("prior")}:e0`, action: "click" } } });
    expect(old.isError).toBe(true);
    const fresh = await handleCallTool({ params: { name: "vortex_act", arguments: { tabId: 42, target: `@${hash("scoped")}:e0`, action: "click" } } });
    expect(fresh.isError).not.toBe(true);
    expect(vi.mocked(sendRequest).mock.calls[2][1]).toMatchObject({ index: 0, snapshotId: "scoped" });
  });

  it("invalidates the old ref after a scoped snapshot and makes the new ref actionable", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValueOnce(snapshot("before-scope") as never)
      .mockResolvedValueOnce(snapshot("after-scope") as never)
      .mockResolvedValueOnce({ result: { success: true } } as never);
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42 } } });
    await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42, target: "#focus" } } });
    const old = await handleCallTool({ params: { name: "vortex_act", arguments: { tabId: 42, target: `@${hash("before-scope")}:e0`, action: "click" } } });
    expect(old.isError).toBe(true);
    expect((old.content[0] as { text: string }).text).toContain("STALE_SNAPSHOT");
    const fresh = await handleCallTool({ params: { name: "vortex_act", arguments: { tabId: 42, target: `@${hash("after-scope")}:e0`, action: "click" } } });
    expect(fresh.isError).not.toBe(true);
    expect(vi.mocked(sendRequest).mock.calls[2][1]).toMatchObject({ index: 0, snapshotId: "after-scope" });
    vi.mocked(sendRequest).mockResolvedValueOnce({ result: { success: true } } as never);
    const bare = await handleCallTool({ params: { name: "vortex_act", arguments: { tabId: 42, target: "@e0", action: "click" } } });
    expect(bare.isError).not.toBe(true);
    expect(vi.mocked(sendRequest).mock.calls[3][1]).toMatchObject({ index: 0, snapshotId: "after-scope" });
  });

  it('preserves explicit frameId when it conflicts with a ref', async () => {
    const { sendRequest } = await import('../src/client.js');
    vi.mocked(sendRequest).mockResolvedValue(snapshot('frame-conflict') as never);
    const { handleCallTool } = await import('../src/server.js');
    await handleCallTool({ params: { name: 'vortex_observe', arguments: { tabId: 42 } } });
    await handleCallTool({ params: { name: 'vortex_observe', arguments: { tabId: 42, frameId: 2, target: `@${hash('frame-conflict')}:f1e3` } } });
    expect(vi.mocked(sendRequest).mock.calls[1][1]).toMatchObject({ frameId: 2 });
  });

  it("reports truncation from a scoped observation", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValueOnce({ result: {
      snapshotId: "limited", url: "https://x/", elements: [],
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/", offset: { x: 0, y: 0 }, elementCount: 80, candidateCount: 90, truncated: true, scanned: true }],
    } } as never);
    const { handleCallTool } = await import("../src/server.js");
    const result = await handleCallTool({ params: { name: "vortex_observe", arguments: { target: "#focus" } } });
    expect((result.content[0] as { text: string }).text).toContain("# truncated: returned 80 of ~90 candidates");
  });

  it("rejects a stale target before issuing another snapshot", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue(snapshot("unexpected") as never).mockResolvedValueOnce(snapshot("active") as never);
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42 } } });
    const result = await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42, target: `@${hash("old")}:e0` } } });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("STALE_SNAPSHOT");
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a ref bound to another tab", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue(snapshot("unexpected") as never).mockResolvedValueOnce(snapshot("tab-bound") as never);
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 42 } } });
    const result = await handleCallTool({ params: { name: "vortex_observe", arguments: { tabId: 43, target: `@${hash("tab-bound")}:e0` } } });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("STALE_SNAPSHOT");
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });
});
