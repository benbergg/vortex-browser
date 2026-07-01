# 通用流程图 readback 框架设计（`vortex_query mode=flow`）

> **状态**：设计已确认待评审（2026-07-01）。下一步 → writing-plans。
> **范围**：可插 adapter 的通用流程图 readback 框架，ipaas processSetting 为首个（当前唯一）adapter。

## 1. 背景与目标

vortex 是 text-first 浏览器感知层。ipaas 数据集成的**集成方案流程图**（`processSetting` 页）用自定义 Vue DOM 渲染节点，模型看不懂流程拓扑 → 只能靠截图。**目标**：读出流程结构以 Mermaid（默认）表达，让模型不截图就理解流程，**减少截图依赖**。哲学对齐图表 Kaizen（`echarts.getOption` / 语雀 lakesheet）：**读框架已有的内存模型，输出结构化文本**。

## 2. 根因诊断（实机 `ipaas-pre.bytenew.com/#/processSetting?id=966`）

| 维度 | 实测 |
|---|---|
| 渲染 | **自定义 Vue DOM**（非 canvas、非 X6/G6/LogicFlow 标准图库）；容器 `.processSetting-body`，节点 DOM div |
| observe 现状 | **能抓节点名**（`span "触发"` / `span "HTTP节点"` / `div "结束"`）——但为**扁平兄弟 span** |
| 根本原因 | **observe 传达"节点标签"却丢失"流程拓扑"**：顺序/方向/分支/并行/循环嵌套（流程图核心）只在①视觉箭头②Vue 模型里。模型据扁平标签重建不出流程 → 截图看视觉拓扑 |
| 数据可达 | Vue `processSetting._data` 有 `startNode + nodesDataList + endNode`，每节点 `{id,name,code,septType,desc,data}`，分支/循环嵌套在 `data.branchData`/`data.iterateSeptData`，完全结构化 |

**结论**：非原语 bug，是拓扑未 surface。解法=lib-aware 流程 readback（读模型→Mermaid），根治截图依赖。

## 3. 非目标（YAGNI）

- **不**做 observe 集成（用户选纯 `mode=flow`）；发现靠工具描述，observe 指路留 backlog。
- **不**在 v1 实现 X6/G6/LogicFlow/bpmn adapter（框架就绪，按需加）。
- **不**做流程编辑/act（纯读）。
- **不**渲染节点完整配置（apiData/groovyScriptData 细节）——v1 只出拓扑 + 节点名/类型；配置摘要留 backlog。

## 4. 架构总览

新增 `vortex_query` 的 `mode=flow`。实现为**自包含 page-side probe 函数** `flowProbeFunc`（与 `sheetProbeFunc`/`geometryProbeFunc` 同构，注入 MAIN world，纯读）。数据流：

```
vortex_query({mode:"flow", pattern, attr})
  → dispatch 到 flowProbeFunc（注入页面）
    → adapter 注册表:逐个 adapter.detect(doc),首个命中
    → adapter.read(doc) → FlowGraph（归一化图）
    → serializeFlow(graph, format) → Mermaid（默认）/ tree / json
  → 返回文本
```

两个明确边界单元：
- **adapter**（承重墙，browser/框架耦合）：detect + read 框架内存模型 → FlowGraph。ipaas adapter 读 Vue。
- **serializeFlow**（纯函数，可离线单测）：`FlowGraph → 文本`。承载 Mermaid/tree/json 渲染,是 load-bearing 逻辑。

## 5. 归一化模型（所有 adapter 映射到此）

```ts
export interface FlowNode { id: string; label: string; type: string; }        // type=语义类型(START/HTTP/PARALLEL/…)
export interface FlowEdge { from: string; to: string; label?: string; }        // label=分支名/条件(可选)
export interface FlowGraph { title?: string; nodes: FlowNode[]; edges: FlowEdge[]; }
```

任意流程图库都能映射进 nodes+edges 图（这是 Mermaid 也是最通用的流程表示）。

## 6. Adapter 接口与注册表

```ts
export interface FlowAdapter {
  name: string;                       // "ipaas" | "x6" | "logicflow" | …
  detect(doc: Document): boolean;     // 当前页是否此库
  read(doc: Document): FlowGraph | null;
}
// 注册表:有序数组,detectFlow(doc) 返回首个 detect 命中的 adapter.read 结果
export function detectAndReadFlow(doc: Document): { adapter: string; graph: FlowGraph } | null;
```

v1 注册表只含 `ipaasAdapter`。加库=push 一个 adapter（detect+read），serializeFlow 与注册表不变。

## 7. ipaas adapter（首个，实测坐实）

- **detect**：`doc.querySelector(".processSetting-body")` 存在 **且** 上溯能找到 Vue 组件（`el.__vue__`）其 `_data.nodesDataList` 为数组。
- **read**（映射 Vue 模型 → FlowGraph）：
  - `title` = `_data.formParams?.name`（方案名称）。
  - 节点序列 = `startNode`(septType START) → `nodesDataList[...]` → `endNode`(septType END)。
  - 每节点 → `FlowNode{ id, label:name, type:septType }`；id 缺失（实测 id 可能 null）时用位置索引 `n<i>` 兜底并保证唯一。
  - **顺序边**：相邻节点 `from→to`（start→n0→n1→…→end）。
  - **并行节点**（septType PARALLEL，`data.branchData` 非空）：对每个分支（branchData 内的子节点序列）递归展开为子图,并行节点 fan-out 到各分支首节点、各分支尾节点 merge 回并行节点的后继；边 label 用分支名。
  - **循环节点**（septType LOOP/迭代，`data.iterateSeptData`）：递归循环体子序列,循环节点→循环体首,循环体尾→循环节点(回边 label "循环")。
  - **⚠ branchData/iterateSeptData 内部形状**（子序列是 `septs[]` 还是嵌套 nodesDataList）当前流程无分支节点未坐实,实现期用带分支的 ipaas 流程 live 确认（见 §12 风险）。read 用防御式访问（字段缺失/空 → 退化为顺序节点,绝不抛）。
  - **纯读**：只读 `_data` 属性,不调用任何 Vue 方法改状态。

## 8. 序列化器（纯函数）

`serializeFlow(graph: FlowGraph, format: "mermaid"|"tree"|"json"): string`

- **mermaid（默认）**：
  ```
  flowchart TD
    n0(["触发 (START)"])
    n1["HTTP节点 (HTTP)"]
    nE(["结束 (END)"])
    n0 --> n1
    n1 --> nE
  ```
  - START/END → stadium `([...])`；PARALLEL → 菱形 `{...}`；其余 → 矩形 `["..."]`。
  - 节点文本 = `label (type)`；转义 mermaid 特殊字符（`"` → `#quot;`、换行 → 空格）。
  - 边有 label → `n1 -->|分支A| n2`。
  - 节点 id 归一化为安全 id（字母数字,非法字符替换）。
- **tree（`attr=tree`）**：缩进大纲,顺序主干 + 并行/循环子项缩进（`├/└` 前缀）。图有 merge/回边时附注 `(→ 汇合到 X)`。
- **json（`attr=json`）**：`{title, nodes, edges}` 原样保真。

## 9. 工具接口（复用 query 现有字段,不新增 schema 字段守 I15 ≤8000）

| 参数 | mode=flow 语义 | 默认 |
|---|---|---|
| `mode` | `"flow"` | — |
| `pattern` | adapter 提示/容器选择器（`*`=自动检测；未来可指定 adapter 名） | `*` |
| `attr` | 格式：`mermaid` / `tree` / `json` | `mermaid` |

mode enum 加 `flow` + description 追加最短一句（`flow=流程图→mermaid`）,回归 tools/list ≤8000 断言。

## 10. 错误与兜底

- 无 adapter 命中（非流程图页 / 未加载完）→ 干净错误信息指向 `vortex_screenshot`（视觉兜底）。
- adapter 命中但图为空 → 返回空图提示,不报错。
- read 内部字段缺失 → 防御式退化（尽力出顺序主干）,不抛。

## 11. 只读安全

`flowProbeFunc` 全程纯读（读 `.__vue__._data` 属性）,不调用任何 Vue 方法/不改状态/不触发保存。满足只读约束。若需带分支流程做验证,用只读工具观察现有流程,不新建/改流程。

## 12. 组件边界与文件

| 文件 | 责任 | 类型 |
|---|---|---|
| `packages/extension/src/page-side/flow-readback.ts`（新）| `FlowGraph` 类型 + `serializeFlow`（mermaid/tree/json 纯序列化器）+ `FlowAdapter` 接口 + `detectAndReadFlow` 注册表 + `ipaasAdapter`(detect/read) | 真源 |
| `packages/extension/src/handlers/query.ts`（改）| `mode=flow` 分派:注入 `flowProbeFunc`（内联 detectAndReadFlow+ipaasAdapter+serializeFlow）→ 返回 | 承重墙 inline |
| `packages/mcp/src/tools/schemas-public.ts`（改）| `vortex_query` mode enum 加 `flow` + 描述 | schema |
| `packages/extension/tests/flow-readback.test.ts`（新）| serializeFlow 纯函数 + ipaasAdapter.read（合成 Vue 模型 mock）单测 | 测试 |
| `packages/extension/tests/query-flow-parity.test.ts`（新）| inline↔真源 parity 断言 | 测试 |

## 13. 测试策略

- **纯序列化器单测**（离线,合成 FlowGraph）：mermaid（节点形状/边/转义/带 label 边）、tree（并行/循环缩进）、json；空图；单节点；并行 fan-out/merge；循环回边。
- **ipaasAdapter.read 单测**（合成 Vue `_data` mock）：start→nodesDataList→end 顺序图；PARALLEL 节点 branchData 递归；LOOP 节点 iterateSeptData 递归；字段缺失防御式退化；title 取 formParams.name。
- **parity 断言**：query.ts 内联副本含真源关键判据字符串（`[inline flow-readback]` 标记）。
- **承重墙真站 live 验收**（ipaas processSetting）：`vortex_query mode=flow` 对 id=966 返回 `flowchart TD` 含 触发(START)→HTTP节点(HTTP)→结束(END) 正确拓扑；**另用一个带并行/循环节点的 ipaas 流程坐实 branchData/iterateSeptData 递归**；`attr=tree`/`json` 正确。
- ext/mcp 全量回归；tools/list ≤8000。

## 14. 分工（opencode-m3 SOP,见 [[vortex_opencode_m3_tmux_sop]]）

- **派 M3**：`serializeFlow` 纯序列化器（mermaid/tree/json）+ 其单测（自包含、判据明确、离线可测）。
- **orchestrator 自留**：`ipaasAdapter`（Vue 模型读 + branchData 递归,需真站校准）、注册表、query 内联承重墙、真站 live 验收（含带分支流程坐实）、parity。
- **并发铁律**：`flow-readback.ts` 被多 Task 编辑须串行（M3 先提交 → orchestrator 接手）。

## 15. 验收标准

1. `vortex_query mode=flow` 对 ipaas processSetting 返回 Mermaid,拓扑与页面一致（真站验）。
2. 并行/循环节点正确嵌套（fan-out/merge、循环回边），branchData/iterateSeptData 递归 live 坐实。
3. `attr=tree`/`json` 正确；mermaid 特殊字符转义无破坏。
4. 非流程图页 / 未命中 → 干净兜底指向 screenshot。
5. 纯读、不改流程；全量单测 + tools/list 预算回归通过。
6. adapter 注册表可插（加新库只写 detect+read,serializeFlow/registry 不变）。

## 16. 风险

- **branchData/iterateSeptData 内部形状未坐实**：当前流程无分支/循环节点。缓解：实现期用带分支的 ipaas 流程 live 探明；read 防御式访问,形状不符时退化为顺序主干（不抛、不误报）。
- **私有 Vue 模型易变**：`nodesDataList`/`septType`/`data.*` 是 ipaas 内部结构,版本升级可能改。缓解：detect 用宽松签名（.processSetting-body + nodesDataList 存在性）,失败干净降级 screenshot。
- **id 缺失/重复**：实测节点 id 可能 null。缓解：位置索引兜底 + 保证 FlowGraph 内 id 唯一。
- **超大流程 token**：v1 全量输出；节点数上限/分页留 backlog。

## 17. Backlog（本期不做）

- observe 指路（blindspot pointer → mode=flow）提升发现性。
- X6/G6/LogicFlow/bpmn/ReactFlow 等标准图库 adapter。
- 节点配置摘要（apiData 的 apiCode/脚本片段等）。
- 超大流程节点数上限/分页。
