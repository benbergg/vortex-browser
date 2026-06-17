# vortex 生产化 backlog（Phase 0 设计审计产出）

> 生成：2026-06-17 ｜ 来源：并行 3 Explore agent 三层审计（感知/执行/协议）
> **铁律**：以下全是**候选**。agent 报告根因默认不可信，每条进修复前必须 Phase 1 活浏览器 spike 核实。
> 可信度图例：🔴未核实(agent 原始) ｜ 🟡已读码部分核实 ｜ 🟢已活浏览器证实
> 配套设计：`docs/superpowers/specs/2026-06-17-vortex-production-readiness-loop-design.md`

## 优先级队列（Phase 1 按此顺序 spike）

### A. 盲区降级信号缺失族（感知层元瓶颈，最高战略价值）
> 共性：observe 因技术限制扫不全时静默返回局部，不给 agent「这里有盲区/已降级/已截断」信号。修复多为**新增信号字段**而非改 bug，需先定信号契约。
> **2026-06-17 实现完成**：A1/A2/A4 ✅ ship+live 复验；A3 defer；A5 未排期。设计 `docs/superpowers/specs/2026-06-17-observe-blindspot-signal-design.md`，计划 `docs/superpowers/plans/2026-06-17-observe-blindspot-signal.md`。

| ID | 标题 | 严重度 | 状态 | 证据 |
|----|------|--------|------|------|
| A1 | canvas 内对象 0 召回无盲区信号 | P1 | ✅ done | per-element `[blindspot=canvas]`+meta；Excalidraw live：canvas 行出标注 |
| A2 | 虚拟列表低召回无截断提示 | P1 | ✅ done | page-side 专扫→frame 级 `# blindspots: ... virtual(N/M)`；ag-grid live `virtual(1003/37)` |
| A4 | 截断无量化 | P2 | ✅ done | candidateCount 透传→`# truncated: returned M of ~N`；ag-grid `80/351` live |
| A3 | closed shadow root 无降级信号 | P1 | ⏸ defer | host 未被收集挂不上 per-element 标签(同虚拟 gap)；需专扫自定义元素(全 DOM 过滤,性能代价)；best-effort/最低价值/误报风险最高。纯函数+单测已留 |
| A5 | iframe scanned 信号未下沉到 element 级 | P2 | ⏸ 未排期 | 现有 frame 级 `# frame N not scanned` 已部分覆盖 |

### B. ref/snapshot 协议语义
| ID | 标题 | 严重度 | 可信度 | 证据 | 验证 |
|----|------|--------|--------|------|------|
| ~~B3~~ | frames 参数 public schema 阉割 number[] 形式 | ~~P1~~→P3 | 🟢证伪 | **已核实非缺陷**：server.ts:189-202 handleCallTool `params=args??{}` 直接透传**不校验**入站参数，number[] 仍可用；public schema 仅 tools/list 字节预算简化(registry.ts:74)。残余仅可发现性(agent 不知有 number[]) | 降级 P3 doc 级 |
| B2 | STALE_SNAPSHOT 错误码混淆「无快照」vs「过期」 | P2（agent 报 P1，已读码降级） | 🟡 | ref-parser.ts:110-114 无快照 throw STALE_SNAPSHOT；line 139 过期同码。**消息文案可区分**（"no active snapshot" vs "expired"），但 error code 相同，靠码分支的 agent 无法区分 | 不 observe 直接 act vs observe→navigate→act |
| B1 | bare ref 同 tab 原地导航不被捕获 | P2（agent 报 P0，已读码证伪降级） | 🟢 | **已核实**：ref-parser.ts:123-134 tabId 门对 bare ref 同样生效；bare ref 仅跳过 line 139 hash 门 → 真实缺口仅「同 tab 原地导航+bare ref」，且 bare ref 计划 v0.9 弃用即解 | 低优先，v0.9 拒绝 bare ref 顺带解决 |

### C. 执行层残余
| ID | 标题 | 严重度 | 可信度 | 证据 | 验证 |
|----|------|--------|--------|------|------|
| ~~C1~~ | SCROLL moved 阈值不一致（dom.ts >1px vs micro-verify <5px）| ~~P1~~ | 🟢证伪 | **已核实非缺陷**：两阈值测不同量——dom.ts:1283 `>1px`=「动没动」位移死区；micro-verify.ts:157 `<5px`=「到没到目标」容差。非双标。moved:false 时 success:true 是有意降级信号(#18,注释明写 agent 据此判真滚动) | 行为正确 |
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
