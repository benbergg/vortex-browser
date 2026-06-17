# vortex 生产化 backlog（Phase 0 设计审计产出）

> 生成：2026-06-17 ｜ 来源：并行 3 Explore agent 三层审计（感知/执行/协议）
> **铁律**：以下全是**候选**。agent 报告根因默认不可信，每条进修复前必须 Phase 1 活浏览器 spike 核实。
> 可信度图例：🔴未核实(agent 原始) ｜ 🟡已读码部分核实 ｜ 🟢已活浏览器证实
> 配套设计：`docs/superpowers/specs/2026-06-17-vortex-production-readiness-loop-design.md`

## 优先级队列（Phase 1 按此顺序 spike）

### A. 盲区降级信号缺失族（感知层元瓶颈，最高战略价值）
> 共性：observe 因技术限制扫不全时静默返回局部，不给 agent「这里有盲区/已降级/已截断」信号。修复多为**新增信号字段**而非改 bug，需先定信号契约。

| ID | 标题 | 严重度 | 可信度 | 证据 | 验证站点 |
|----|------|--------|--------|------|----------|
| A1 | canvas 内对象 0 召回无盲区信号 | P1 | 🔴 | observe.ts:1360-1363 ROOT_SELECTORS 仅 DOM；检测到 `<canvas>` 且返回 0 元素时不报「canvas 编辑器观察受限」 | Excalidraw / LogicFlow / draw.io |
| A2 | 虚拟列表低召回无截断提示 | P1 | 🔴 | observe.ts:1409-1448 无虚拟列表检测；`[role=listbox]` childIds vs DOM children 无对比 | ag-grid / antd Table 虚拟滚动 / 淘宝搜索 |
| A3 | closed shadow root 无降级信号 | P1 | 🔴 | observe.ts:1365-1389 querySelectorAllDeep 仅穿 open shadow，注释承认 closed 不可见但无信号；observe-render.ts:74-88 无盲区字段 | Shoelace / mode:'closed' 自定义元素 |
| A4 | 截断无量化（漏多少未知） | P2 | 🔴 | observe.ts:2086 `truncated` 仅布尔，无 truncatedCount；frame 级无 candidateCount | 京东商品列表（历史可触发截断） |
| A5 | iframe scanned 信号未下沉到 element 级 | P2 | 🔴 | observe.ts:2376-2387 frame 级 `scanned:false`，但 observe-render.ts:64-72 CompactElement 无「来自未扫 frame」反向标记 | Zendesk / Jira Cloud 嵌套跨域 iframe |

### B. ref/snapshot 协议语义
| ID | 标题 | 严重度 | 可信度 | 证据 | 验证 |
|----|------|--------|--------|------|------|
| B3 | frames 参数 public schema 阉割 number[] 形式 | P1 | 🔴 | schemas-public.ts:82 仅 enum；schemas.ts:137-143 oneOf 含 number[]；handler observe.ts:22 支持 number[]。schema 撒谎缩小 agent 探索空间 | `vortex_observe({frames:[0,2]})` 调用核对 |
| B2 | STALE_SNAPSHOT 错误码混淆「无快照」vs「过期」 | P2（agent 报 P1，已读码降级） | 🟡 | ref-parser.ts:110-114 无快照 throw STALE_SNAPSHOT；line 139 过期同码。**消息文案可区分**（"no active snapshot" vs "expired"），但 error code 相同，靠码分支的 agent 无法区分 | 不 observe 直接 act vs observe→navigate→act |
| B1 | bare ref 同 tab 原地导航不被捕获 | P2（agent 报 P0，已读码证伪降级） | 🟢 | **已核实**：ref-parser.ts:123-134 tabId 门对 bare ref 同样生效；bare ref 仅跳过 line 139 hash 门 → 真实缺口仅「同 tab 原地导航+bare ref」，且 bare ref 计划 v0.9 弃用即解 | 低优先，v0.9 拒绝 bare ref 顺带解决 |

### C. 执行层残余
| ID | 标题 | 严重度 | 可信度 | 证据 | 验证 |
|----|------|--------|--------|------|------|
| C1 | SCROLL moved 阈值不一致（dom.ts >1px vs micro-verify <5px）| P1 | 🔴 | dom.ts:1282-1284 `Math.abs > 1`；micro-verify.ts:156-159 `<5` pass。两套阈值，且 moved:false 不触发 NO_EFFECT，success 仍 true | sticky 容器 / transform 动画中的滚动容器 |
| C3 | ARIA select driver 虚拟列表越界项无降级 | P1 | 🔴 | aria-select.ts:215-227 optionPool 基于 collectVisible；line 135-143 `isVisible` 要求 w/h>0 → 虚拟外项被过滤，报 UNKNOWN_OPTION 而非等待滚动暴露 | antd Select 选项>视口 / react-select+虚拟列表 |
| C2 | FILL reject 两套机制不统一 | P2 | 🔴 | fill-reject.ts:27-55 仅 Element Plus；dom.ts:910-917 原生 input 内联探测。两套条件可能分叉致自定义组件漏拦 | rc-checkbox / 自定义 radio 库 |
| C4 | TYPE vs FILL clearBefore 语义不对称 | P2 | 🔴 | dom.ts:716-717 TYPE 清空再输入；dom.ts:935-938 FILL 直接覆盖。受控+防抖组件两者副作用路径不同 | 受控 input+防抖 / contentEditable+框架绑定 |

### D. 低优先 / 高度推测（待证伪，多半 m3-error）
> 这些与历史已修批次重叠或纯推测，优先级最低，逐条快速证伪即可。

| ID | 标题 | 说明 |
|----|------|------|
| D1 | PRESS 可打印字符+修饰键缺 text（执行-1 P0） | 记忆显示批次5/0008 已修 PRESS text/物理码，疑重复，优先证伪 |
| D2 | CLICK synthetic inline 副本同步 aria-disabled（执行-7） | 纯推测，已有 click-synthetic-inline-scope.test 守 |
| D3 | DRAG 跨 frame offset 顺序（执行-8） | 推测，需 iframe 内拖拽场景证 |
| D4 | content-visibility 过滤盲区（感知-4） | observe.ts:1844-1891 已有注释处理，疑正确行为 |
| D5 | data-vtx-listener 生命周期（感知-7） | 与 snapshot 生命周期重叠 |
| D6 | AX overlay 仅主 frame（感知-8） | observe-ax-overlay.ts:101 v1 已知设计取舍 |
| D7 | tools/list 描述模糊（协议-4） | 体验优化非缺陷 |
| D8 | NO_EFFECT 错误码枚举不全（协议-6） | 需核对是否真混用 |

## Phase 1 建议顺序
1. **C1**（SCROLL 阈值不一致）——最自洽、易 spike、修复隔离，先开胃证明 cycle 跑通。
2. **B3**（frames schema 阉割）——读两个 schema 文件即可核实，修复小。
3. **A2/A1/A3**（盲区信号族）——最高战略价值，但需先 brainstorm 信号契约。
4. **C3/C2/C4** 执行层残余。
5. **D 族** 逐条快速证伪。

## 备注
- Phase 0 期间感知层审计 agent 越界执行了 `rm -rf /tmp/*`（已记录，后续 agent prompt 禁写/删）。
