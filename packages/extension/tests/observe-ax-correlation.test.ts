import { describe, it, expect, vi } from "vitest";
import { captureAXNodeMap } from "../src/reasoning/ax-snapshot.js";
import { buildIndexToBackend, applyOverlay } from "../src/handlers/observe-ax-overlay.js";
import type { CDPAXNode } from "../src/reasoning/types.js";

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

describe("buildIndexToBackend", () => {
  it("取 data-vtx-ax → {index: backendId},穿 shadowRoots", () => {
    const root = {
      backendNodeId: 1, nodeName: "BODY", attributes: [],
      children: [
        { backendNodeId: 100, nodeName: "BUTTON", attributes: ["data-vtx-ax", "0"] },
        { backendNodeId: 200, nodeName: "DIV", attributes: ["class", "x"],
          shadowRoots: [{ backendNodeId: 250, nodeName: "#document-fragment", attributes: [],
            children: [{ backendNodeId: 300, nodeName: "A", attributes: ["data-vtx-ax", "1"] }] }] },
      ],
    };
    const m = buildIndexToBackend(root as any);
    expect(m.get(0)).toBe(100);
    expect(m.get(1)).toBe(300);
  });
  it("不进 contentDocument(子 frame 标记被忽略,避免跨 frame 键冲突)", () => {
    const root = {
      backendNodeId: 1, nodeName: "BODY", attributes: [],
      children: [
        { backendNodeId: 100, nodeName: "BUTTON", attributes: ["data-vtx-ax", "0"] },
        { backendNodeId: 200, nodeName: "IFRAME", attributes: [],
          contentDocument: { backendNodeId: 500, nodeName: "#document", attributes: [],
            children: [{ backendNodeId: 600, nodeName: "BUTTON", attributes: ["data-vtx-ax", "0"] }] } },
      ],
    };
    const m = buildIndexToBackend(root as any);
    expect(m.get(0)).toBe(100);   // 主 frame 的,不被子 frame backendId=600 覆盖
    expect(m.size).toBe(1);
  });
});

describe("applyOverlay 命中覆盖", () => {
  const ax = (o: Partial<CDPAXNode>): CDPAXNode => ({ nodeId: "x", ...o });
  it("命中:role/name/state 覆盖;controls remap backendId→index", () => {
    const els = [
      { role: "div", name: "", reactClickable: true as const },
      { role: "div", name: "面板" },
    ];
    const indexToBackend = new Map([[0, 100], [1, 200]]);
    const byBackend = new Map<number, CDPAXNode>([
      [100, ax({ role: { value: "tab" }, name: { value: "详情" },
        properties: [{ name: "selected", value: { value: true } },
                     { name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 200 }] } }] })],
      [200, ax({ role: { value: "tabpanel" }, name: { value: "面板" } })],
    ]);
    applyOverlay(els as any, indexToBackend, byBackend, new Map());
    expect(els[0].role).toBe("tab");
    expect(els[0].name).toBe("详情");
    expect((els[0] as any).state?.selected).toBe(true);
    // R4 B012 修复:AX 路径设的 controls 改用 B008 形状 [{index:N}] 而非纯
    // 数字数组 [N](后者被渲染层当 {index:N, id:undefined} 用,拼出
    // controls=#undefined)。B008 形状与 page-side aria-controls 路径对齐。
    expect((els[0] as any).controls).toEqual([{ index: 1 }]);
    expect((els[0] as any).nameSource).toBeDefined();
  });
});
