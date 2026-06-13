import { describe, it, expect, vi } from "vitest";
import { captureAXNodeMap } from "../src/reasoning/ax-snapshot.js";

describe("captureAXNodeMap", () => {
  it("returns {byBackend, byNodeId}; byBackend skips nodes without backendId", async () => {
    const fakeNodes = [
      { nodeId: "1", role: { value: "button" }, name: { value: "保存" }, backendDOMNodeId: 100 },
      { nodeId: "2", role: { value: "text" }, name: { value: "x" } }, // 无 backendId → byBackend 跳过,byNodeId 仍收
      { nodeId: "3", role: { value: "checkbox" }, name: { value: "同意" }, backendDOMNodeId: 200,
        properties: [{ name: "checked", value: { value: true } }] },
    ];
    const dbg = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({ nodes: fakeNodes }),
    };
    const { byBackend, byNodeId } = await captureAXNodeMap(dbg as any, 1, 0);
    expect(byBackend.size).toBe(2);
    expect(byBackend.get(100)?.role?.value).toBe("button");
    expect(byBackend.get(200)?.name?.value).toBe("同意");
    expect(byNodeId.size).toBe(3);
    expect(byNodeId.get("2")?.role?.value).toBe("text");
    expect(dbg.sendCommand).toHaveBeenCalledWith(1, "Accessibility.getFullAXTree", undefined);
  });
});
