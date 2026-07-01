# 通用流程图 readback 实现计划（`vortex_query mode=flow`）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `vortex_query mode=flow` 把 ipaas 集成方案流程图读成 Mermaid（默认，可切 tree/json），减少截图依赖，并做成可插 adapter 框架。

**Architecture:** 新增 page-side probe `flowProbeFunc`（注入 MAIN world，纯读），adapter 注册表逐个 detect→首个命中 read 出归一化 `FlowGraph`（nodes+edges）→ `serializeFlow` 渲染 Mermaid。ipaas adapter 读 Vue `processSetting._data`。核心落真源 `flow-readback.ts`（纯逻辑离线单测），probe 内联同一逻辑（注入丢作用域），parity 断言守同步。

**Tech Stack:** TypeScript、Chrome MV3 `chrome.scripting.executeScript({world:"MAIN"})`、Vue2 `__vue__._data` 内省、Vitest（jsdom）。

## Global Constraints

- **注释中文**（代码标识符/API 名保留英文）；**禁止** `Co-Authored-By`/`Signed-off-by` 署名。
- **提交走 Conventional Commits**（`type: 中文描述`，动词开头，结尾无句号）——git-commit skill 规范。
- **page-side 注入函数必须自包含**：`flowProbeFunc` 内联所有 helper（注入丢模块作用域 → 引用模块级符号会 `X is not defined`）；真源与内联用 parity 断言同步（既有模式 `[inline sheet-readback]`）。
- **只读安全**：全程纯读 `.__vue__._data` 属性，不调用任何 Vue 方法/不改状态/不触发保存。
- **MCP tools/list ≤ 8000 字节**（I15 预算）——mode enum 加 `flow` + 描述微调后回归该断言。
- **不新增 query schema 字段**：复用 `pattern`（adapter/容器选择器）、`attr`（格式）。
- **分工**（见 [[vortex_opencode_m3_tmux_sop]]）：Task 1（纯序列化器）可派 M3；Task 2–3（Vue 模型读/probe 承重墙/真站 live）orchestrator 自留。`flow-readback.ts` 被 Task 1/2 先后编辑，须 Task 1 提交后 Task 2 接手。

---

### Task 1: `FlowGraph` 类型 + `serializeFlow` 纯序列化器

真源纯函数：`FlowGraph`（nodes+edges 图）→ Mermaid / tree / json 文本。**纯函数、零浏览器依赖、离线单测打透**——load-bearing 逻辑。**可派 M3。**

**Files:**
- Create: `packages/extension/src/page-side/flow-readback.ts`
- Test: `packages/extension/tests/flow-readback.test.ts`

**Interfaces:**
- Produces:
  - `interface FlowNode { id: string; label: string; type: string; }`
  - `interface FlowEdge { from: string; to: string; label?: string; }`
  - `interface FlowGraph { title?: string; nodes: FlowNode[]; edges: FlowEdge[]; }`
  - `type FlowFormat = "mermaid" | "tree" | "json";`
  - `function serializeFlow(graph: FlowGraph, format: FlowFormat): string`

- [ ] **Step 1: 写失败测试（mermaid 线性流程）**

`packages/extension/tests/flow-readback.test.ts`：

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/flow-readback.test.ts`
Expected: FAIL —「serializeFlow is not a function」/ 模块不存在。

- [ ] **Step 3: 最小实现**

`packages/extension/src/page-side/flow-readback.ts`：

```typescript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/flow-readback.test.ts`
Expected: PASS（1 例）。

- [ ] **Step 5: 补齐覆盖测试（并行菱形/带 label 边/转义/tree/json/空图）**

追加到同测试文件：

```typescript
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
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `cd packages/extension && pnpm vitest run tests/flow-readback.test.ts`
Expected: PASS（6 例）。

- [ ] **Step 7: 提交**

```bash
git add packages/extension/src/page-side/flow-readback.ts packages/extension/tests/flow-readback.test.ts
git commit -m "feat: 加通用流程图 readback 纯序列化器(mermaid/tree/json)"
```

---

### Task 2: adapter 注册表 + ipaas adapter（Vue 模型 → FlowGraph）

真源补上 adapter 接口、注册表、ipaas adapter（读 Vue `processSetting._data` → FlowGraph，递归 branchData/iterateSeptData）。**orchestrator 自留**（Vue 模型读需真站校准）；用合成 Vue mock 单测。

**Files:**
- Modify: `packages/extension/src/page-side/flow-readback.ts`
- Test: `packages/extension/tests/flow-readback.test.ts`

**Interfaces:**
- Consumes: `FlowGraph`/`FlowNode`/`FlowEdge`（Task 1）。
- Produces:
  - `interface FlowAdapter { name: string; detect(doc: Document): boolean; read(doc: Document): FlowGraph | null; }`
  - `const ipaasAdapter: FlowAdapter`
  - `function detectAndReadFlow(doc: Document): { adapter: string; graph: FlowGraph } | null`

- [ ] **Step 1: 写失败测试（ipaas adapter 读合成 Vue 模型）**

追加到 `tests/flow-readback.test.ts`（顶部加 `// @vitest-environment jsdom`，若尚无）：

```typescript
import { detectAndReadFlow, ipaasAdapter } from "../src/page-side/flow-readback.js";

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/flow-readback.test.ts`
Expected: FAIL —「detectAndReadFlow is not a function」。

- [ ] **Step 3: 实现 adapter 接口 + 注册表 + ipaasAdapter**

追加到 `flow-readback.ts`：

```typescript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/extension && pnpm vitest run tests/flow-readback.test.ts`
Expected: PASS（Task 1 的 6 + 本任务 4 = 10 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/page-side/flow-readback.ts packages/extension/tests/flow-readback.test.ts
git commit -m "feat: 加流程图 adapter 注册表与 ipaas adapter(Vue 模型→FlowGraph)"
```

---

### Task 3: `vortex_query mode=flow` 端到端接线（probe 内联 + dispatch + schema）

把 `mode=flow` 接进 query.ts：`flowProbeFunc`（**内联** detect+read+serialize）+ dispatch + 参数校验 + MCP schema + parity。**orchestrator 自留**，ipaas 真站 live 验收（含带分支流程坐实 branchData 形状）。

**Files:**
- Modify: `packages/extension/src/handlers/query.ts`（加 `flowProbeFunc` + dispatch）
- Modify: `packages/mcp/src/tools/schemas-public.ts`（mode enum + description）
- Test: `packages/extension/tests/query-flow-parity.test.ts`（新，parity）
- Test: `packages/mcp/tests/`（tools/list ≤8000 既有断言回归）

**Interfaces:**
- Consumes: 真源 `serializeFlow`/`detectAndReadFlow`/`ipaasAdapter`（Task 1/2）——**逻辑内联**进 `flowProbeFunc`（不 import，注入丢作用域）。
- Produces: `flowProbeFunc(pattern: string, format: string)` 返回 `{ text: string } | { error: string }`。

- [ ] **Step 1: 写失败测试（parity 断言：内联副本含真源关键字符串）**

`packages/extension/tests/query-flow-parity.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/handlers/query.ts"), "utf8");

describe("flowProbeFunc 内联 ↔ flow-readback 真源 parity", () => {
  it("query.ts 含 [inline flow-readback] 标记", () => {
    expect(src).toContain("[inline flow-readback]");
  });
  it("内联含 ipaas detect + Vue 模型读判据(与真源一致)", () => {
    expect(src).toContain(".processSetting-body");
    expect(src).toContain("_data && Array.isArray(cur.__vue__._data.nodesDataList)");
  });
  it("内联含 mermaid 渲染 + branchData 递归(与真源一致)", () => {
    expect(src).toContain("flowchart TD");
    expect(src).toContain("branchData"); // 并行递归
    expect(src).toContain('#quot;');      // mermaid `"` 转义
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/extension && pnpm vitest run tests/query-flow-parity.test.ts`
Expected: FAIL —「[inline flow-readback] 未找到」。

- [ ] **Step 3: 加 `flowProbeFunc`（自包含内联）**

在 `packages/extension/src/handlers/query.ts` 的 `sheetProbeFunc` 之后插入。**全部逻辑内联**（detect+read+serialize，逐字对齐真源 Task 1/2）：

```typescript
/**
 * page-side 流程图 readback 函数体。mode=flow 注入 MAIN world。
 * 参数 args: [pattern(adapter/容器提示), format(mermaid|tree|json)]。
 * 返回 { text } 或 { error }。⚠ [inline flow-readback]:注入丢模块作用域,detect/read/
 * serialize 必须内联;逻辑须与 src/page-side/flow-readback.ts 真源一致(改一处须改两处),
 * query-flow-parity.test.ts 校验。纯读,不调用 Vue 方法(只读安全)。
 */
export const flowProbeFunc = (
  pattern: string,
  format: string,
): { text: string } | { error: string } => {
  try {
    const doc = document;
    // —— ipaas adapter: detect + read(内联真源 findIpaasVm/ipaasAdapter.read)——
    const body = doc.querySelector(".processSetting-body");
    let vm: any = null;
    if (body) {
      let cur: any = body, hops = 0;
      while (cur && hops < 15) {
        if (cur.__vue__ && cur.__vue__._data && Array.isArray(cur.__vue__._data.nodesDataList)) { vm = cur.__vue__; break; }
        cur = cur.parentElement; hops++;
      }
    }
    if (!vm) return { error: "no flow diagram on page (未检测到流程图；若确在流程页请等待加载，或用 vortex_screenshot)" };

    const d = vm._data;
    const nodes: Array<{ id: string; label: string; type: string }> = [];
    const edges: Array<{ from: string; to: string; label?: string }> = [];
    let counter = 0;
    const genId = (n: any): string => (n && n.id != null && n.id !== "null" ? `ip_${n.id}_${counter++}` : `n${counter++}`);
    const subSeq = (x: any): any[] =>
      Array.isArray(x) ? x
      : x && Array.isArray(x.septs) ? x.septs
      : x && Array.isArray(x.nodes) ? x.nodes
      : x && Array.isArray(x.children) ? x.children
      : [];
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
        if (Array.isArray(data.branchData) && data.branchData.length) {
          for (const branch of data.branchData) {
            const bseq = subSeq(branch);
            if (!bseq.length) continue;
            const r = expand(bseq, null);
            if (r.first) edges.push({ from: id, to: r.first, label: (branch && (branch.name || branch.branchName)) || "分支" });
          }
        }
        const loop = subSeq(data.iterateSeptData);
        if (loop.length) { const r = expand(loop, null); if (r.first) edges.push({ from: id, to: r.first, label: "循环" }); }
      }
      return { first, last };
    };
    let mainPrev: string | null = null;
    if (d.startNode && typeof d.startNode === "object") {
      const sid = genId(d.startNode);
      nodes.push({ id: sid, label: String(d.startNode.name || "开始"), type: String(d.startNode.septType || "START") });
      mainPrev = sid;
    }
    const bodyRes = expand(Array.isArray(d.nodesDataList) ? d.nodesDataList : [], mainPrev);
    mainPrev = bodyRes.last ?? mainPrev;
    if (d.endNode && typeof d.endNode === "object") {
      const eid = genId(d.endNode);
      nodes.push({ id: eid, label: String(d.endNode.name || "结束"), type: String(d.endNode.septType || "END") });
      if (mainPrev) edges.push({ from: mainPrev, to: eid });
    }
    const title = d.formParams && typeof d.formParams.name === "string" ? d.formParams.name : undefined;
    const graph = { title, nodes, edges };

    // —— serialize(内联真源 serializeFlow)——
    const escFlow = (s: string): string => String(s ?? "").replace(/\r?\n/g, " ").replace(/"/g, "#quot;").trim();
    const fmt = format === "tree" || format === "json" ? format : "mermaid";
    if (fmt === "json") return { text: JSON.stringify(graph) };
    if (fmt === "tree") {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const lines: string[] = [];
      if (graph.title) lines.push(`流程: ${graph.title}`);
      graph.nodes.forEach((n, i) => {
        lines.push(`${i + 1}. ${n.label} (${n.type})`);
        for (const e of graph.edges.filter((ed) => ed.from === n.id)) {
          const tgt = byId.get(e.to);
          lines.push(`   → ${tgt ? tgt.label : e.to}${e.label ? ` [${e.label}]` : ""}`);
        }
      });
      return { text: lines.join("\n") };
    }
    // mermaid
    const idx = new Map<string, string>();
    graph.nodes.forEach((n, i) => idx.set(n.id, `N${i}`));
    const lines: string[] = ["flowchart TD"];
    if (graph.title) lines.push(`  %% ${escFlow(graph.title)}`);
    for (const n of graph.nodes) {
      const mid = idx.get(n.id)!;
      const text = `${escFlow(n.label)} (${escFlow(n.type)})`;
      const t = (n.type || "").toUpperCase();
      lines.push("  " + (t === "START" || t === "END" ? `${mid}(["${text}"])` : t === "PARALLEL" ? `${mid}{"${text}"}` : `${mid}["${text}"]`));
    }
    for (const e of graph.edges) {
      const f = idx.get(e.from), t = idx.get(e.to);
      if (!f || !t) continue;
      lines.push(e.label ? `  ${f} -->|${escFlow(e.label)}| ${t}` : `  ${f} --> ${t}`);
    }
    return { text: lines.join("\n") };
  } catch (e) {
    return { error: "flow readback error: " + (e instanceof Error ? e.message : String(e)) };
  }
};
```

> **`pattern` 在 v1 仅用于校验非空**（`*` 自动检测 ipaas）；未来多 adapter 时用它指定 adapter 名。

- [ ] **Step 4: 加 dispatch case + mode 校验**

在 `packages/extension/src/handlers/query.ts` 的 mode 校验加入 `flow`（与 `sheet` 并列）：

```typescript
      if (
        !mode ||
        (mode !== "text" && mode !== "css" && mode !== "component" &&
         mode !== "geometry" && mode !== "style" && mode !== "sheet" && mode !== "flow")
      ) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `vortex_query: mode must be 'text', 'css', 'component', 'geometry', 'style', 'sheet' or 'flow', got ${String(mode)}`,
        );
      }
```

在 `mode === "sheet"` 分支之后插入 flow 分支：

```typescript
      } else if (mode === "flow") {
        // flow 模式:注入 flowProbeFunc,adapter 检测流程图→读模型→mermaid/tree/json。
        const format = typeof args.attr === "string" ? args.attr : "mermaid";

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: flowProbeFunc,
          args: [pattern, format],
          world: "MAIN",
        });

        const res = results[0]?.result as { text: string } | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage flow: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage flow error: ${res.error}`);
        }
        return res;
      } else if (mode === "sheet") {
```

> 把新分支插在 `sheet` 分支**之前**（改 `} else if (mode === "sheet") {` 为先 `} else if (mode === "flow") { … } else if (mode === "sheet") {`），保持既有 sheet/style/component 分支不动。

- [ ] **Step 5: 改 MCP schema（mode enum + 描述）**

`packages/mcp/src/tools/schemas-public.ts` 的 `vortex_query`：

mode enum 加 `flow`：
```typescript
        mode: { enum: ["text", "css", "component", "geometry", "style", "sheet", "flow"] },
```

description 末尾追加（尽量短，守 I15 ≤8000）：
```typescript
    description: "Zero-LLM probe: text=grep; css=find elems(+attr); component=Vue/React state+row; geometry=bbox/clip/occlude; style=color/bg/WCAG; sheet=Lake Sheet→md/csv/json; flow=流程图→mermaid(attr=格式).",
```

- [ ] **Step 6: 跑 parity + tools/list 预算回归**

Run: `cd packages/extension && pnpm vitest run tests/query-flow-parity.test.ts`
Expected: PASS（3 例）。

Run: `cd packages/mcp && pnpm vitest run`（含 tools/list ≤8000 断言）
Expected: PASS。若逼近上限,进一步压 description（如 `flow=流程图→mermaid`）。

- [ ] **Step 7: 构建 + ipaas 真站 live 验收（orchestrator，非自动化）**

Run: `cd /Users/lg/workspace/vortex && cd packages/extension && pnpm build:main`
Expected: 通过；`flowProbeFunc` 编入 SW bundle。

live 验收（ipaas processSetting 页）：
```
vortex_query({ mode: "flow", pattern: "*" })
```
Expected：返回 `flowchart TD`，含 触发(START)→HTTP节点(HTTP)→结束(END) 正确拓扑；再验 `attr:"tree"`/`attr:"json"`。
**关键**：另开/切到一个**带并行或循环节点**的 ipaas 流程，验 branchData/iterateSeptData 递归——若真实 branchData 内部形状与 `subSeq` 假定（`septs`/`nodes`/`children`/数组）不符,据实调整 `subSeq` 并回补单测，再 live 复验。若无带分支流程可用,记录该验收项 pending 并在描述里标注 v1 仅线性坐实。

- [ ] **Step 8: 提交**

```bash
git add packages/extension/src/handlers/query.ts packages/mcp/src/tools/schemas-public.ts packages/extension/tests/query-flow-parity.test.ts
git commit -m "feat(query): 加 mode=flow 流程图结构化 readback(ipaas→mermaid)"
```

---

## 收尾（全 3 任务后）

- [ ] **全量回归**：`cd packages/extension && pnpm vitest run` + `cd packages/mcp && pnpm vitest run`，全绿；tools/list ≤8000。
- [ ] **reflexion 双轮自查**（见 [[ship_checklist_vortex]]）。
- [ ] **更新记忆**：新建 `vortex_flow_readback.md`（mode=flow ship、ipaas Vue 模型路径、mermaid 输出、branchData 坐实结果、adapter 框架）。
- [ ] **分支收尾**：ff 合并 main 或开 PR（用户定）。

## Self-Review（对照 spec）

- **Spec §4 架构**（mode=flow + adapter 注册表 + 序列化）→ Task 1（serialize）+ Task 2（registry）+ Task 3（inline）✓
- **Spec §5 归一化模型** FlowGraph → Task 1 类型 ✓
- **Spec §6 adapter 接口/注册表** → Task 2 `FlowAdapter`/`detectAndReadFlow` ✓
- **Spec §7 ipaas adapter**（detect/read、septType、branchData/iterateSeptData 递归、title）→ Task 2 `ipaasAdapter` ✓
- **Spec §8 序列化器**（mermaid 默认/tree/json、shape、转义）→ Task 1 `serializeFlow` + 测试 ✓
- **Spec §9 工具接口**（pattern/attr 复用、mode enum、tools/list 预算）→ Task 3 Step 4/5 ✓
- **Spec §10 错误兜底**（指向 screenshot）→ Task 3 `flowProbeFunc` error 分支 ✓
- **Spec §11 只读安全**（不调 Vue 方法）→ Task 2/3 纯读 + 注释 ✓
- **Spec §13 测试**（纯序列化器 + adapter mock + parity + 真站 live 含带分支坐实）→ Task 1/2/3 ✓
- **Spec §16 风险**（branchData 形状未坐实 → 防御式 subSeq + Task 3 Step 7 live 探明）✓
- **类型一致性**：`FlowGraph`/`FlowNode`/`FlowEdge`/`FlowFormat`/`serializeFlow`/`FlowAdapter`/`detectAndReadFlow`/`ipaasAdapter` 贯穿 Task 1→3 一致 ✓
- **无 observe 集成**（spec §3 非目标,用户选纯 mode=flow）→ 计划无对应 Task,一致 ✓
