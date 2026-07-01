import { describe, it, expect } from "vitest";
import { serializeFlow, type FlowGraph } from "../src/page-side/flow-readback.js";

const linear: FlowGraph = {
  title: "获取标签选项方案",
  nodes: [
    { id: "s", label: "触发", type: "START" },
    { id: "n1", label: "HTTP节点", type: "HTTP" },
    { id: "e", label: "结束", type: "END" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "e" },
  ],
};

describe("serializeFlow mermaid", () => {
  it("线性流程 → flowchart TD,START/END stadium、边 -->", () => {
    const out = serializeFlow(linear, "mermaid");
    const lines = out.split("\n");
    expect(lines[0]).toBe("flowchart TD");
    expect(out).toContain('N0(["触发 (START)"])');   // START stadium
    expect(out).toContain('N1["HTTP节点 (HTTP)"]');   // 普通矩形
    expect(out).toContain('N2(["结束 (END)"])');      // END stadium
    expect(out).toContain("N0 --> N1");
    expect(out).toContain("N1 --> N2");
  });
});

const branched: FlowGraph = {
  nodes: [
    { id: "p", label: "并行", type: "PARALLEL" },
    { id: "a", label: 'A"节点', type: "HTTP" },
    { id: "b", label: "B\n节点", type: "SCRIPT" },
  ],
  edges: [
    { from: "p", to: "a", label: "分支1" },
    { from: "p", to: "b", label: "分支2" },
  ],
};

describe("serializeFlow 其他", () => {
  it("PARALLEL 菱形 + 带 label 边", () => {
    const out = serializeFlow(branched, "mermaid");
    expect(out).toContain('N0{"并行 (PARALLEL)"}');   // 菱形
    expect(out).toContain("N0 -->|分支1| N1");
    expect(out).toContain("N0 -->|分支2| N2");
  });
  it("转义 `\"` 与换行", () => {
    const out = serializeFlow(branched, "mermaid");
    expect(out).toContain('A#quot;节点');   // " → #quot;
    expect(out).toContain("B 节点");         // 换行 → 空格
  });
  it("tree 缩进大纲", () => {
    const out = serializeFlow(branched, "tree");
    expect(out).toContain("1. 并行 (PARALLEL)");
    expect(out).toContain("   → A\"节点 [分支1]");
  });
  it("json 保真", () => {
    const j = JSON.parse(serializeFlow(branched, "json"));
    expect(j.nodes).toHaveLength(3);
    expect(j.edges[0]).toEqual({ from: "p", to: "a", label: "分支1" });
  });
  it("空图 → 仅 flowchart TD 头", () => {
    expect(serializeFlow({ nodes: [], edges: [] }, "mermaid")).toBe("flowchart TD");
  });
});
