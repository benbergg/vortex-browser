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
