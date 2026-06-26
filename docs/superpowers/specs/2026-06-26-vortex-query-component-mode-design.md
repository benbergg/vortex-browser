# vortex_query mode=component + T1-2 网络残余收口 — 设计

> 派生自知识库 `12-Projects/vortex-自主探索缺陷发现/`：
> - N002 `2026-06-26-vortex-MCP不截图能力评测-V1-设计`（缺陷归类，识别 T1-1/T1-2/T1-3）
> - N003 `2026-06-26-vortex-MCP核心能力缺陷同行调研`（同行金标准映射）
> - N004 `2026-06-26-vortex-MCP能力深度调研与竞品分析`（5 竞品 + 8 CDP 域）

## 0. 核实结论（驱动本设计的前提，非推测）

三份报告的能力盘点为黑盒推测，实机白盒核对（2026-06-26）后修订如下：

| 缺陷 | 报告结论 | 实机核实 | 本轮处置 |
|---|---|---|---|
| **T1-2** POST-only 接口须装 fetch hook | **最高 ROI**，需新增网络捕获工具 | **伪命题**：`packages/extension/src/handlers/network.ts` 已用 CDP Network 域全量捕获 requestBody(`:175`)/responseBody(`:244`,base64 感知)/headers/status，自动订阅(`:62`)+Resource Timing 回填(`:102`)；公开工具 `vortex_debug_read`(`schemas-public.ts:215`) 已暴露 `source=network`(列表+requestId) 与 `source=request,reqid=`(单请求 status+headers+body, `network.ts:469`)，等价 Playwright MCP `browser_network_request`。评测员手搓 fetch hook 是不知道既有能力 | **残余收口**（块 B）：`GET_REQUEST_DETAIL` 返回补 `requestBody`；强化 `debug_read` 描述消除误用根因 |
| **T1-1** 视觉语义零信息 | 真缺口 | 确认真缺口：全仓 `getComputedStyle` 仅用于 cursor 检测/visibility 门，无结构化视觉工具；但有 `vortex_evaluate` workaround + `vortex_screenshot` 兜底 | **本轮不做** |
| **T1-3** 行内 row id / 闭包不可见 | 真缺口，5 竞品空白=差异化机会 | 确认真缺口：无组件/行数据封装，evaluate 能 hack `__vue__` 但需手写上溯 | **本轮主攻**（块 A） |

教训沿用：报告诊断默认不可信须实机核实；"能力缺口"常实为"LLM 不知道既有能力"。

## 1. 范围与交付决策

- 交付面：**扩展现有 `vortex_query` 加 `mode=component`**，不新增公开工具（I15 预算仅 60~75B 余量，靠 cap 微调）。
- 范围（YAGNI）：**组件数据 + 表行数据**两件，**砍掉 slot_scope 闭包 proxy**（侵入式改写活页面、需重渲染才生效、脆弱）。表行数据走"读组件响应式 store"而非闭包。
- 框架：**Vue 2/3 + React 一起**。
- 不在范围：T1-1 视觉语义、独立工具、slot_scope proxy、AG-Grid/其他表格库的硬保证（best-effort）。

## 2. 架构总览

一个特性两块，复用现有 page-side 注入链 `window.__vortexDomResolve.queryAllDeep(selector)`（穿 open shadow + 与 @ref 一致）：

- **块 A**：`vortex_query mode=component` —— 命中元素 → 框架探测 → 上溯组件链取 `{name,data,props}` → 表格上下文探测行数据。承重件是 `safeSerialize`。
- **块 B**：网络残余两处一行级收口。

## 3. 块 A：`vortex_query mode=component`

### 3.1 输入（复用 query schema）

| 字段 | 说明 |
|---|---|
| `mode: "component"` | 与 `text`/`css` 并列新枚举 |
| `pattern` | CSS 选择器（复用现字段；component 模式下即 selector） |
| `componentDepth?` | 上溯层数，默认 `3`（实机订正，原 4） |
| `maxResults?` | 复用 |
| `tabFields` | 复用 |

### 3.2 输出

数组，每命中元素一项（受 maxResults 限）：

```json
{
  "framework": "vue2 | vue3 | react | unknown",
  "chain": [{ "name": "string", "data": {}, "props": {} }],
  "row": { "rowKey": "string|number|null", "row": {}, "index": 0 }
}
```

- `chain`：最近优先，至多 `componentDepth` 层。
- `row`：命中元素处于可识别表格/列表行时才有，否则字段缺省。

### 3.3 page-side 算法

1. `queryAllDeep(selector)` 解析（穿 open shadow）→ 截 `maxResults`。
2. **框架探测**（按元素本身 + 必要时祖先）：
   - Vue2：`el.__vue__` truthy
   - Vue3：`el.__vueParentComponent` truthy
   - React：自有属性键匹配 `/^__reactFiber\$/`（回退 `/^__reactInternalInstance\$/`）
   - 都不命中 → `framework:"unknown"`，`chain:[]`（优雅，非 error）
3. **上溯链取数**（至多 `componentDepth` 层）：
   - Vue2：`{ name: inst.$options.name || inst.$options._componentTag, data: safeSerialize(inst._data), props: safeSerialize(inst.$props) }`；climb `inst = inst.$parent`
   - Vue3：`{ name: vnode.type.name || vnode.type.__name, data: safeSerialize(vnode.setupState), props: safeSerialize(vnode.props) }`；climb `vnode = vnode.parent`
   - React：跳过 host fiber（`typeof fiber.type !== "function"`）；取 `{ name: fiber.type.displayName || fiber.type.name, props: ser(fiber.memoizedProps), data: ser(fiber.memoizedState) }`；climb `fiber = fiber.return`。注：`data` 为 hook 链表原始结构（首发只取浅层，由深度3+预算有界）
4. **行数据探测**（库相关）—— **实机 spike(2026-06-26)订正,实现数值见此节**：
   - **Vue2 + vxe-table（硬保证）**：ipaas 实际用 vxe-table（N002 误标 el-table）。上溯到 `$options.name === "VxeTable"` → `tr[rowid]` + `inst.getRowById(rowid)` 取行，`index` 用 `inst.getRowIndex(row)`。**不依赖 DOM 索引，抗虚拟滚动/固定列,实机验证通过**（rowKey=rowid）。
   - **React + antd Table（硬保证）**：沿 `fiber.return` 找带 `record`/`row`/`rowData` 的祖先；rowKey 优先 `memoizedProps.rowKey`/`data-row-key`，**回退 `record.key`/`record.id`**（实机发现 record 在 cell fiber、rowKey 在 row fiber，故须回退）。实机验证通过（rowKey="1"）。
   - **Vue2 + Element UI el-table（best-effort,非硬保证）**：上溯 `ElTable` → `store.states.data` + `closest("tr")` 同级索引。**仅理想化 mock 测过,未经真实「固定列」el-table 实机验证**（固定列渲染独立 table/tbody，索引可能取错行，错行比缺省更糟）→ 降级 best-effort，站点须实机校准后才可信。
   - 其余表格库 best-effort，拿不到则 `row` 缺省，不报错。

### 3.4 承重件 序列化（`makeSerializer` 工厂）—— 实机 spike 订正

实机 spike 发现单一 `safeSerialize` 在真实 vxe-table 组件 `_data` 上**输出爆炸**（曾吐 10 万字符超 token 限）。改为 `makeSerializer(perCallCap)` 工厂 + **全局节点预算**，独立纯函数 + 重单测：

- **全局节点预算 `globalBudget.cap = 3000`**：所有 serializer 共享,容器循环内命中即 break，硬封顶整次调用输出。
- **两遍序列化**：先序列化所有元素的 `row`（首要交付物，优先吃预算），再 chain（次要吃余额）→ 高 maxResults 时靠后元素的 row 不被前面 chain 饿死。
- 深度上限 `MAX_DEPTH = 3`，超出 → `"[MaxDepth]"`（原设计 4，实测组件内部过深，降到 3）
- 数组截断 `ARRAY_CAP = 40`，超出附 `"[+N more]"`（原设计 100）
- `function` → `"[Function]"`；DOM `Node` → `"[Element]"`；循环引用 → `"[Circular]"`（WeakSet 路径追踪 add/finally-delete）
- 剥 Vue 响应式内部键（`__ob__`、`__v_*`）；getter 抛错 per-key try/catch → `"[Unserializable]"`
- 对象超预算 break 时附 `"__vtxTruncated__": "[Budget]"` 标记；预算耗尽统一返 `"[Budget]"`
- handler 默认：component `maxResults` 默认 `5` / 上限 `10`、`componentDepth` 默认 `3`（原设计 10/20/4，因组件数据重 + 预算硬兜底而调低）

### 3.5 降级与错误

- 0 命中 → 空数组（与 css mode 一致）。
- 命中无框架实例 → `framework:"unknown"` + 空 chain，非 error。
- 序列化异常局部化，绝不让整次调用失败。

## 4. 块 B：T1-2 残余收口

- **B1**：`network.ts` `GET_REQUEST_DETAIL` 返回对象补 `requestBody: entry.requestBody ?? null`（已于 `:175` 采集，`:528` 返回漏吐）。一行 + 测试。
- **B2**：`vortex_debug_read` 描述强化，点明 `source=network/request` 已捕获 POST 请求/响应体、无需手搓 fetch hook。**实测字节后定 I15 cap**（按惯例"加能力调 cap 不压字符"）。

## 5. 测试与验收

- **单测**：
  - `safeSerialize`：深度/函数/DOM/循环/响应式剥离/数组截断/getter 抛错。
  - 框架探测三态（vue2/vue3/react fixture）。
  - 链上溯（mock 实例链）。
  - 行探测：el-table(Vue2 mock store) + antd Table(React mock fiber)。
  - B1：`GET_REQUEST_DETAIL` 返回含 requestBody。
- **实机 spike（强制）**：
  - ipaas-pre el-table(Vue2) 确认 `store.states.data` + rowKey 精确路径。
  - 一个 antd React 表格站确认 `memoizedProps` 行对象路径。
- **I15 不变量**：更新 cap/count/names，测试通过；B2 字节实测后定 cap。
- **bench**：本改动不碰 observe-scan，A 层召回不应变；reload 后跑一次确认无回归。

## 6. 非目标 / backlog

- T1-1 视觉语义（visual_snapshot/design_tokens/pseudo_state/lighthouse）。
- slot_scope 闭包 proxy（仅当 store 路径在某些组件拿不到时再考虑）。
- React hooks 链深度序列化（首发只取浅层）。
- AG-Grid / 其他表格库行探测硬保证。
- el-table（含固定列）真实站点实机校准后从 best-effort 升回硬保证。
- 大体积 POST body：`GET_REQUEST_DETAIL` 现依赖 `requestWillBeSent` 内联 `postData`，CDP 对大 body 仅置 `hasPostData` 不带 `postData` → 需补 `Network.getRequestPostData` 兜底（M-2）。
- 独立 `vortex_component` 工具（如未来 query 描述过载再拆）。
