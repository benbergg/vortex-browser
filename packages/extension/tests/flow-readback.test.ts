// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { serializeFlow, type FlowGraph, detectAndReadFlow, ipaasAdapter } from "../src/page-side/flow-readback.js";

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

// 合成 ipaas Vue 模型:.processSetting-body 挂 __vue__._data(start→nodesDataList→end)
function mountIpaas(data: any): void {
  document.body.innerHTML = `<div class="processSetting-body"></div>`;
  const body = document.querySelector(".processSetting-body")! as any;
  body.__vue__ = { _data: data };
}

describe("ipaasAdapter.read", () => {
  it("start→nodesDataList→end 线性图 + septType 作 type", () => {
    mountIpaas({
      formParams: { name: "获取标签选项方案" },
      startNode: { id: "s", name: "触发", septType: "START", data: {} },
      nodesDataList: [{ id: "1", name: "HTTP节点", septType: "HTTP", data: { apiData: {} } }],
      endNode: { id: "e", name: "结束", septType: "END", data: {} },
    });
    const g = ipaasAdapter.read(document)!;
    expect(g.title).toBe("获取标签选项方案");
    expect(g.nodes.map((n) => n.type)).toEqual(["START", "HTTP", "END"]);
    expect(g.nodes.map((n) => n.label)).toEqual(["触发", "HTTP节点", "结束"]);
    // 顺序边 start→http→end
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0].from).toBe(g.nodes[0].id);
    expect(g.edges[0].to).toBe(g.nodes[1].id);
    expect(g.edges[1].to).toBe(g.nodes[2].id);
  });

  it("并行节点递归 branchData(假定形状 [{name,septs:[]}])→ fan-out 边", () => {
    mountIpaas({
      startNode: { id: "s", name: "触发", septType: "START", data: {} },
      nodesDataList: [{
        id: "p", name: "并行", septType: "PARALLEL",
        data: { branchData: [
          { name: "分支A", septs: [{ id: "a", name: "脚本A", septType: "SCRIPT", data: {} }] },
          { name: "分支B", septs: [{ id: "b", name: "脚本B", septType: "SCRIPT", data: {} }] },
        ] },
      }],
      endNode: { id: "e", name: "结束", septType: "END", data: {} },
    });
    const g = ipaasAdapter.read(document)!;
    // 含并行节点 + 两分支子节点
    expect(g.nodes.some((n) => n.type === "PARALLEL")).toBe(true);
    expect(g.nodes.filter((n) => n.type === "SCRIPT")).toHaveLength(2);
    // 并行节点 fan-out 到分支首节点,边带分支名
    const par = g.nodes.find((n) => n.type === "PARALLEL")!;
    expect(g.edges.some((e) => e.from === par.id && e.label === "分支A")).toBe(true);
  });

  it("非 ipaas 页 detect=false / read=null", () => {
    document.body.innerHTML = `<div>x</div>`;
    expect(ipaasAdapter.detect(document)).toBe(false);
    expect(ipaasAdapter.read(document)).toBeNull();
    expect(detectAndReadFlow(document)).toBeNull();
  });

  it("detectAndReadFlow 命中 ipaas 返回 {adapter,graph}", () => {
    mountIpaas({
      startNode: { id: "s", name: "触发", septType: "START", data: {} },
      nodesDataList: [], endNode: { id: "e", name: "结束", septType: "END", data: {} },
    });
    const r = detectAndReadFlow(document)!;
    expect(r.adapter).toBe("ipaas");
    expect(r.graph.nodes.map((n) => n.type)).toEqual(["START", "END"]);
  });
});
