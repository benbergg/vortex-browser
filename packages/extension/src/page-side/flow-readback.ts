/**
 * 通用流程图 readback 真源(纯逻辑)。FlowGraph 是各 adapter 归一化后的图(nodes+edges),
 * serializeFlow 渲染 Mermaid(默认)/tree/json。
 * ⚠ page-side probe(query.ts flowProbeFunc)内联同一逻辑(注入丢模块作用域),
 * 改一处须改两处;query-flow-parity.test.ts 校验。
 */
export interface FlowNode { id: string; label: string; type: string; }
export interface FlowEdge { from: string; to: string; label?: string; }
export interface FlowGraph { title?: string; nodes: FlowNode[]; edges: FlowEdge[]; }
export type FlowFormat = "mermaid" | "tree" | "json";

/** mermaid 文本转义:换行→空格、`"`→`#quot;`、裁空白。 */
function escFlow(s: string): string {
  return String(s ?? "").replace(/\r?\n/g, " ").replace(/"/g, "#quot;").trim();
}

function renderMermaid(graph: FlowGraph): string {
  // 节点 id 一律映射为安全唯一的 N<index>(原 id 可能含非法字符/为 null)。
  const idx = new Map<string, string>();
  graph.nodes.forEach((n, i) => idx.set(n.id, `N${i}`));
  const lines: string[] = ["flowchart TD"];
  if (graph.title) lines.push(`  %% ${escFlow(graph.title)}`);
  for (const n of graph.nodes) {
    const mid = idx.get(n.id)!;
    const text = `${escFlow(n.label)} (${escFlow(n.type)})`;
    const t = (n.type || "").toUpperCase();
    const shaped =
      t === "START" || t === "END" ? `${mid}(["${text}"])`
      : t === "PARALLEL" ? `${mid}{"${text}"}`
      : `${mid}["${text}"]`;
    lines.push(`  ${shaped}`);
  }
  for (const e of graph.edges) {
    const f = idx.get(e.from), t = idx.get(e.to);
    if (!f || !t) continue; // 跳过悬空边
    lines.push(e.label ? `  ${f} -->|${escFlow(e.label)}| ${t}` : `  ${f} --> ${t}`);
  }
  return lines.join("\n");
}

function renderTree(graph: FlowGraph): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  if (graph.title) lines.push(`流程: ${graph.title}`);
  graph.nodes.forEach((n, i) => {
    lines.push(`${i + 1}. ${n.label} (${n.type})`);
    for (const e of graph.edges.filter((ed) => ed.from === n.id)) {
      const tgt = byId.get(e.to);
      const lbl = e.label ? ` [${e.label}]` : "";
      lines.push(`   → ${tgt ? tgt.label : e.to}${lbl}`);
    }
  });
  return lines.join("\n");
}

export function serializeFlow(graph: FlowGraph, format: FlowFormat): string {
  if (format === "json") return JSON.stringify(graph);
  if (format === "tree") return renderTree(graph);
  return renderMermaid(graph);
}

export interface FlowAdapter {
  name: string;
  detect(doc: Document): boolean;
  read(doc: Document): FlowGraph | null;
}

/** 从 .processSetting-body 上溯找带 _data.nodesDataList 的 Vue 组件。 */
function findIpaasVm(doc: Document): any | null {
  const body = doc.querySelector(".processSetting-body");
  if (!body) return null;
  let cur: any = body, hops = 0;
  while (cur && hops < 15) {
    if (cur.__vue__ && cur.__vue__._data && Array.isArray(cur.__vue__._data.nodesDataList)) return cur.__vue__;
    cur = cur.parentElement; hops++;
  }
  return null;
}

export const ipaasAdapter: FlowAdapter = {
  name: "ipaas",
  detect(doc: Document): boolean {
    return findIpaasVm(doc) !== null;
  },
  read(doc: Document): FlowGraph | null {
    const vm = findIpaasVm(doc);
    if (!vm) return null;
    const d = vm._data;
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let counter = 0;
    const genId = (n: any): string =>
      n && n.id != null && n.id !== "null" ? `ip_${n.id}_${counter++}` : `n${counter++}`;
    // 防御式取子序列:branch 可能是数组本身,或 {septs}/{nodes}/{children}。
    const subSeq = (x: any): any[] =>
      Array.isArray(x) ? x
      : x && Array.isArray(x.septs) ? x.septs
      : x && Array.isArray(x.nodes) ? x.nodes
      : x && Array.isArray(x.children) ? x.children
      : [];
    // 展开一段节点序列,顺序连边;返回 {first,last} 供上层接线。空段返回全 null。
    const expand = (seq: any[], prevId: string | null): { first: string | null; last: string | null } => {
      let last = prevId, first: string | null = null;
      for (const node of seq || []) {
        if (!node || typeof node !== "object") continue;
        const id = genId(node);
        const type = String(node.septType || node.type || "NODE");
        nodes.push({ id, label: String(node.name || node.nodeName || type), type });
        if (last) edges.push({ from: last, to: id });
        if (first === null) first = id;
        last = id;
        const data = node.data || {};
        // 并行/分支:每分支 fan-out(边带分支名),v1 不显式 merge 回后继(留 backlog)。
        if (Array.isArray(data.branchData) && data.branchData.length) {
          for (const branch of data.branchData) {
            const bseq = subSeq(branch);
            if (!bseq.length) continue;
            const r = expand(bseq, null);
            if (r.first) edges.push({ from: id, to: r.first, label: (branch && (branch.name || branch.branchName)) || "分支" });
          }
        }
        // 循环体:回边 label "循环"。
        const loop = subSeq(data.iterateSeptData);
        if (loop.length) {
          const r = expand(loop, null);
          if (r.first) edges.push({ from: id, to: r.first, label: "循环" });
        }
      }
      return { first, last };
    };
    // start
    let mainPrev: string | null = null;
    if (d.startNode && typeof d.startNode === "object") {
      const sid = genId(d.startNode);
      nodes.push({ id: sid, label: String(d.startNode.name || "开始"), type: String(d.startNode.septType || "START") });
      mainPrev = sid;
    }
    // 主干
    const bodyRes = expand(Array.isArray(d.nodesDataList) ? d.nodesDataList : [], mainPrev);
    mainPrev = bodyRes.last ?? mainPrev;
    // end
    if (d.endNode && typeof d.endNode === "object") {
      const eid = genId(d.endNode);
      nodes.push({ id: eid, label: String(d.endNode.name || "结束"), type: String(d.endNode.septType || "END") });
      if (mainPrev) edges.push({ from: mainPrev, to: eid });
    }
    const title = d.formParams && typeof d.formParams.name === "string" ? d.formParams.name : undefined;
    return { title, nodes, edges };
  },
};

const FLOW_ADAPTERS: FlowAdapter[] = [ipaasAdapter];

export function detectAndReadFlow(doc: Document): { adapter: string; graph: FlowGraph } | null {
  for (const a of FLOW_ADAPTERS) {
    try {
      if (a.detect(doc)) {
        const graph = a.read(doc);
        if (graph) return { adapter: a.name, graph };
      }
    } catch { /* adapter 异常 → 跳过,尝试下一个 */ }
  }
  return null;
}
